const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json({limit: "256kb"}));

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();
const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

app.get("/", (_req, res) => res.json({ok: true, service: "Student Portal AI Attendance API"}));
app.get("/health", (_req, res) => res.json({ok: true}));

async function authenticate(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    const e = new Error("Missing Firebase ID token."); e.status = 401; throw e;
  }
  try {
    return await admin.auth().verifyIdToken(header.substring(7).trim());
  } catch (_) {
    const e = new Error("Invalid or expired Firebase ID token."); e.status = 401; throw e;
  }
}

app.post("/analyze-attendance", async (req, res) => {
  try {
    const decoded = await authenticate(req);
    const callerUid = decoded.uid;
    const studentUid = String(req.body?.studentUid || "").trim();
    if (!studentUid) return res.status(400).json({error: "studentUid is required."});

    let authorized = callerUid === studentUid;
    if (!authorized) {
      const link = await db.collection("parent_children").doc(`${callerUid}_${studentUid}`).get();
      const x = link.data();
      authorized = link.exists && x?.parentUid === callerUid && x?.studentUid === studentUid;
    }
    if (!authorized) return res.status(403).json({error: "You cannot analyze this student's attendance."});

    const snap = await db.collection("attendance").where("studentUid", "==", studentUid).get();
    const rows = snap.docs.map((d) => {
      const x = d.data();
      let date = null;
      if (x.date?.toDate) date = x.date.toDate().toISOString().slice(0, 10);
      else if (typeof x.date === "string") date = x.date.slice(0, 10);
      return {date, status: String(x.status || "").toLowerCase().trim()};
    }).filter((x) => x.date && ["present","late","absent","excused"].includes(x.status))
      .sort((a,b) => a.date.localeCompare(b.date));

    if (!rows.length) return res.json({
      level: "Not enough data",
      summary: "There are no teacher-recorded attendance entries available for analysis yet.",
      recommendation: "Wait for attendance records to be added by the teacher."
    });

    const counts = {present:0, late:0, absent:0, excused:0};
    rows.forEach((r) => counts[r.status]++);
    const recentRecords = rows.slice(-20);

    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
      input: [
        {role:"system", content:"Analyze school attendance records. Be concise, supportive, and factual. Do not diagnose or invent causes. Base conclusions only on supplied teacher-recorded attendance. Return ONLY valid JSON with keys level, summary, recommendation. level must be Good, Monitor, or Needs Attention. summary max 2 short sentences; recommendation max 1 short sentence."},
        {role:"user", content: JSON.stringify({counts, recentRecords})}
      ],
      max_output_tokens: 220
    });

    let text = (response.output_text || "").replace(/^```json\s*/i,"").replace(/```$/i,"").trim();
    try {
      const p = JSON.parse(text);
      return res.json({
        level: String(p.level || "Monitor"),
        summary: String(p.summary || "Attendance data was analyzed."),
        recommendation: String(p.recommendation || "Continue monitoring teacher-recorded attendance.")
      });
    } catch (_) {
      return res.json({
        level:"Monitor",
        summary:text.slice(0,500) || "Attendance data was analyzed, but the AI response could not be formatted.",
        recommendation:"Continue monitoring teacher-recorded attendance."
      });
    }
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({error: e.status ? e.message : "Attendance analysis failed. Please try again."});
  }
});

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => console.log(`Listening on ${port}`));
