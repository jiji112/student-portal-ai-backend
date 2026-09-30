const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "256kb" }));

// ============================================================
// FIREBASE ADMIN
// ============================================================

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(
      /\\n/g,
      "\n"
    ),
  }),
});

const db = admin.firestore();

// ============================================================
// OPENAI
// ============================================================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================================================
// BASIC ROUTES
// ============================================================

app.get("/", (_req, res) => {
  return res.json({
    ok: true,
    service: "Student Portal AI Attendance API",
  });
});

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
  });
});

// ============================================================
// FIREBASE AUTHENTICATION
// ============================================================

async function authenticate(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    const error = new Error("Missing Firebase ID token.");
    error.status = 401;
    throw error;
  }

  const token = header.substring(7).trim();

  if (!token) {
    const error = new Error("Missing Firebase ID token.");
    error.status = 401;
    throw error;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);

    // Safe diagnostic information.
    // The actual Firebase token is NEVER printed.
    console.log("Firebase authentication OK:", {
      uid: decoded.uid,
      aud: decoded.aud,
      iss: decoded.iss,
    });

    return decoded;
  } catch (err) {
    // Safe diagnostic logging.
    // Does NOT print:
    // - Firebase ID token
    // - Firebase private key
    // - OpenAI API key
    console.error("FIREBASE AUTH ERROR:", {
      code: err?.code || "unknown",
      message: err?.message || "Unknown Firebase authentication error.",
      projectId: process.env.FIREBASE_PROJECT_ID || "missing",
    });

    const error = new Error(
      `Firebase authentication failed: ${err?.code || "unknown-error"}`
    );

    error.status = 401;
    throw error;
  }
}

// ============================================================
// AI ATTENDANCE ANALYSIS
// ============================================================

app.post("/analyze-attendance", async (req, res) => {
  try {
    // --------------------------------------------------------
    // 1. VERIFY FIREBASE USER
    // --------------------------------------------------------

    const decoded = await authenticate(req);

    const callerUid = decoded.uid;

    const studentUid = String(
      req.body?.studentUid || ""
    ).trim();

    if (!studentUid) {
      return res.status(400).json({
        error: "studentUid is required.",
      });
    }

    // --------------------------------------------------------
    // 2. AUTHORIZE STUDENT / PARENT
    // --------------------------------------------------------

    // Student can analyze own attendance.
    let authorized = callerUid === studentUid;

    // If caller is not the student,
    // check whether caller is linked as parent.
    if (!authorized) {
      const linkId = `${callerUid}_${studentUid}`;

      const link = await db
        .collection("parent_children")
        .doc(linkId)
        .get();

      const linkData = link.data();

      authorized =
        link.exists &&
        linkData?.parentUid === callerUid &&
        linkData?.studentUid === studentUid;
    }

    if (!authorized) {
      return res.status(403).json({
        error:
          "You cannot analyze this student's attendance.",
      });
    }

    // --------------------------------------------------------
    // 3. LOAD ATTENDANCE FROM FIRESTORE
    // --------------------------------------------------------

    const snapshot = await db
      .collection("attendance")
      .where("studentUid", "==", studentUid)
      .get();

    const rows = snapshot.docs
      .map((doc) => {
        const data = doc.data();

        let date = null;

        // Firestore Timestamp
        if (data.date?.toDate) {
          date = data.date
            .toDate()
            .toISOString()
            .slice(0, 10);
        }

        // String date
        else if (typeof data.date === "string") {
          date = data.date.slice(0, 10);
        }

        const status = String(
          data.status || ""
        )
          .toLowerCase()
          .trim();

        return {
          date,
          status,
        };
      })
      .filter(
        (row) =>
          row.date &&
          [
            "present",
            "late",
            "absent",
            "excused",
          ].includes(row.status)
      )
      .sort((a, b) =>
        a.date.localeCompare(b.date)
      );

    // --------------------------------------------------------
    // 4. NO ATTENDANCE YET
    // --------------------------------------------------------

    if (!rows.length) {
      return res.json({
        level: "Not enough data",
        summary:
          "There are no teacher-recorded attendance entries available for analysis yet.",
        recommendation:
          "Wait for attendance records to be added by the teacher.",
      });
    }

    // --------------------------------------------------------
    // 5. COUNT ATTENDANCE
    // --------------------------------------------------------

    const counts = {
      present: 0,
      late: 0,
      absent: 0,
      excused: 0,
    };

    rows.forEach((row) => {
      if (
        Object.prototype.hasOwnProperty.call(
          counts,
          row.status
        )
      ) {
        counts[row.status]++;
      }
    });

    // Only send the latest 20 records to AI.
    const recentRecords = rows.slice(-20);

    console.log("Attendance analysis request:", {
      callerUid,
      studentUid,
      totalRecords: rows.length,
      counts,
    });

    // --------------------------------------------------------
    // 6. OPENAI ANALYSIS
    // --------------------------------------------------------

    const response = await openai.responses.create({
      model:
        process.env.OPENAI_MODEL ||
        "gpt-5.6-luna",

      input: [
        {
          role: "system",
          content:
            "Analyze school attendance records. " +
            "Be concise, supportive, and factual. " +
            "Do not diagnose or invent causes. " +
            "Base conclusions only on supplied teacher-recorded attendance. " +
            "Return ONLY valid JSON with keys level, summary, recommendation. " +
            "level must be Good, Monitor, or Needs Attention. " +
            "summary max 2 short sentences. " +
            "recommendation max 1 short sentence.",
        },
        {
          role: "user",
          content: JSON.stringify({
            counts,
            recentRecords,
          }),
        },
      ],

      max_output_tokens: 220,
    });

    // --------------------------------------------------------
    // 7. READ OPENAI RESPONSE
    // --------------------------------------------------------

    let text = (
      response.output_text || ""
    )
      .replace(/^```json\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(text);

      return res.json({
        level: String(
          parsed.level || "Monitor"
        ),

        summary: String(
          parsed.summary ||
            "Attendance data was analyzed."
        ),

        recommendation: String(
          parsed.recommendation ||
            "Continue monitoring teacher-recorded attendance."
        ),
      });
    } catch (parseError) {
      console.error(
        "AI JSON PARSE ERROR:",
        parseError?.message
      );

      return res.json({
        level: "Monitor",

        summary:
          text.slice(0, 500) ||
          "Attendance data was analyzed, but the AI response could not be formatted.",

        recommendation:
          "Continue monitoring teacher-recorded attendance.",
      });
    }
  } catch (error) {
    console.error("ATTENDANCE API ERROR:", {
      status: error?.status || 500,
      message:
        error?.message || "Unknown error",
    });

    return res
      .status(error?.status || 500)
      .json({
        error: error?.status
          ? error.message
          : "Attendance analysis failed. Please try again.",
      });
  }
});

// ============================================================
// START SERVER
// ============================================================

const port = process.env.PORT || 10000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Listening on ${port}`);
});
