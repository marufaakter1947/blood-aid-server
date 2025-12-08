// require('dotenv').config(); // <-- load .env first
// const express = require('express');
// const cors = require('cors');
// const { MongoClient } = require('mongodb');

// const app = express();
// const port = process.env.PORT || 5000;
// app.use(express.json());

// app.use(
//   cors({
//     origin: process.env.CLIENT_DOMAIN || '*',
//   })
// );

// // MongoDB connection
// const uri = process.env.MONGO_URI;

// if (!uri) {
//   console.error('MongoDB URI is not defined in .env');
//   process.exit(1);
// }

// const client = new MongoClient(uri, {
//   serverApi: { version: '1', strict: true, deprecationErrors: true },
// });

// async function run() {
//   try {
//     await client.connect();
//     console.log('MongoDB connected successfully');

//     const db = client.db('bloodAidDB');
//     const usersCollection = db.collection('users');

//     // Test route
//     app.get('/', (req, res) => {
//       res.send('Blood Aid Server is Running');
//     });

//     // POST /users route
//     app.post('/users', async (req, res) => {
//       try {
//         const user = req.body;

//         // Simple validation
//         if (!user.email || !user.name) {
//           return res.status(400).json({ error: 'Name and email are required' });
//         }

//         const result = await usersCollection.insertOne(user);
//         res.status(201).json(result);
//       } catch (err) {
//         console.error(err);
//         res.status(500).json({ error: 'Failed to create user' });
//       }
//     });

//     app.listen(port, () => {
//       console.log(`Blood Aid Application listening on port ${port}`);
//     });
//   } catch (err) {
//     console.error('MongoDB connection failed', err);
//   }
// }

// run().catch(console.dir);
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

/* ------------------ Middleware ------------------ */
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
  })
);
app.use(express.json());

/* ------------------ Firebase Admin ------------------ */
const decoded = Buffer.from(
  process.env.FB_SERVICE_KEY,
  "base64"
).toString("utf-8");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(decoded)),
});

/* ------------------ MongoDB ------------------ */
const client = new MongoClient(process.env.MONGODB_URI);

/* ------------------ JWT Verify ------------------ */
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized" });

  try {
    const decodedUser = await admin.auth().verifyIdToken(token);
    req.email = decodedUser.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Invalid Token" });
  }
};

async function run() {
  try {
    const db = client.db("bloodAidDB");
    const usersCollection = db.collection("users");
    const requestsCollection = db.collection("donationRequests");

    /* ------------ Role Middlewares ------------ */
    const verifyAdmin = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.email });
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "Admin only" });
      }
      next();
    };

    /* ------------ Save / Update User ------------ */
    app.post("/users", async (req, res) => {
      const user = req.body;

      const existing = await usersCollection.findOne({ email: user.email });

      if (existing) {
        await usersCollection.updateOne(
          { email: user.email },
          { $set: { lastLogin: new Date() } }
        );
        return res.send({ success: true });
      }

      const newUser = {
        ...user,
        role: "donor",
        status: "active",
        createdAt: new Date(),
      };

      await usersCollection.insertOne(newUser);
      res.send({ success: true });
    });

    /* ------------ Get Logged-in User ------------ */
    app.get("/users/me", verifyJWT, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.email });
      res.send(user);
    });

    /* ------------ Update Profile ------------ */
    app.patch("/users/profile", verifyJWT, async (req, res) => {
      const updateData = req.body;

      const result = await usersCollection.updateOne(
        { email: req.email },
        { $set: updateData }
      );

      res.send(result);
    });

    /* ------------ Get All Donors ------------ */
    app.get("/donors", async (req, res) => {
      const result = await usersCollection
        .find({ role: "donor", status: "active" })
        .project({ password: 0 })
        .toArray();

      res.send(result);
    });

    /* ------------ Donation Request ------------ */
    app.post("/donation-requests", verifyJWT, async (req, res) => {
      const request = {
        ...req.body,
        requester: req.email,
        status: "pending",
        createdAt: new Date(),
      };

      const result = await requestsCollection.insertOne(request);
      res.send(result);
    });

    /* ------------ Admin: All Users ------------ */
    app.get("/admin/users", verifyJWT, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    /* ------------ Admin: Update Role ------------ */
    app.patch("/admin/role", verifyJWT, verifyAdmin, async (req, res) => {
      const { email, role } = req.body;

      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } }
      );

      res.send(result);
    });

    console.log("✅ BloodAid Backend Connected");
  } finally {
  }
}
run();

app.get("/", (req, res) => {
  res.send("BloodAid Server Running");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
