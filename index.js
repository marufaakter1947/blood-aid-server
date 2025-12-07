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
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());
app.use(
  cors({
    origin: process.env.CLIENT_DOMAIN || '*',
  })
);

// MongoDB connection
const client = new MongoClient(process.env.MONGO_URI, {
  serverApi: { version: '1', strict: true, deprecationErrors: true },
});

async function run() {
  try {
    await client.connect();
    console.log('MongoDB connected successfully');

    const db = client.db('bloodAidDB');
    const usersCollection = db.collection('users');
    const donationsCollection = db.collection('donations');

    // -----------------------------
    // JWT Middleware
    // -----------------------------
    const verifyJWT = (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
      const token = authHeader.split(' ')[1];
      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Forbidden' });
        req.user = decoded;
        next();
      });
    };

    // Admin check middleware
    const verifyAdmin = (req, res, next) => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      next();
    };

    // -----------------------------
    // Auth Routes
    // -----------------------------
    app.post('/signup', async (req, res) => {
      const { name, email, password, role = 'donor' } = req.body;
      if (!name || !email || !password)
        return res.status(400).json({ error: 'Name, email & password required' });

      const existing = await usersCollection.findOne({ email });
      if (existing) return res.status(400).json({ error: 'User already exists' });

      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = { name, email, password: hashedPassword, role, status: 'active', createdAt: new Date() };
      await usersCollection.insertOne(newUser);

      const token = jwt.sign({ email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });
      res.status(201).json({ token });
    });

    app.post('/login', async (req, res) => {
      const { email, password } = req.body;
      const user = await usersCollection.findOne({ email });
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });

      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ error: 'Invalid credentials' });

      const token = jwt.sign({ email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
      res.json({ token });
    });

    // -----------------------------
    // Users CRUD (Admin only)
    // -----------------------------
    app.get('/users', verifyJWT, verifyAdmin, async (req, res) => {
      const { status } = req.query; // filter active/blocked
      const query = status ? { status } : {};
      const users = await usersCollection.find(query).toArray();
      res.json(users);
    });

    app.patch('/users/:id/block', verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await usersCollection.updateOne({ _id: ObjectId(id) }, { $set: { status: 'blocked' } });
      res.json(result);
    });

    app.patch('/users/:id/unblock', verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await usersCollection.updateOne({ _id: ObjectId(id) }, { $set: { status: 'active' } });
      res.json(result);
    });

    app.patch('/users/:id/role', verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body; // donor, volunteer, admin
      const result = await usersCollection.updateOne({ _id: ObjectId(id) }, { $set: { role } });
      res.json(result);
    });

    // -----------------------------
    // Donation Requests CRUD
    // -----------------------------
    // Get all donations (Admin) or own donations (Donor)
    app.get('/donations', verifyJWT, async (req, res) => {
      const { status, page = 1, limit = 10 } = req.query;
      const query = {};

      if (status) query.status = status;

      // Donor can see only their own donations
      if (req.user.role === 'donor') query.createdBy = req.user.email;

      const donations = await donationsCollection
        .find(query)
        .skip((page - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .toArray();
      res.json(donations);
    });

    // Create donation (Donor only & active)
    app.post('/donations', verifyJWT, async (req, res) => {
      if (req.user.role !== 'donor') return res.status(403).json({ error: 'Donor only' });

      const user = await usersCollection.findOne({ email: req.user.email });
      if (user.status !== 'active') return res.status(403).json({ error: 'Blocked user cannot create requests' });

      const donation = { ...req.body, createdBy: req.user.email, status: 'pending', createdAt: new Date() };
      const result = await donationsCollection.insertOne(donation);
      res.status(201).json(result);
    });

    // Update donation request (Donor owns it / Admin all / Volunteer status only)
    app.patch('/donations/:id', verifyJWT, async (req, res) => {
      const id = req.params.id;
      const donation = await donationsCollection.findOne({ _id: ObjectId(id) });
      if (!donation) return res.status(404).json({ error: 'Donation not found' });

      // Permissions
      if (req.user.role === 'donor' && donation.createdBy !== req.user.email)
        return res.status(403).json({ error: 'Not allowed' });

      if (req.user.role === 'volunteer') {
        // Volunteer can update only status
        const { status } = req.body;
        if (!status) return res.status(400).json({ error: 'Status required' });
        const result = await donationsCollection.updateOne({ _id: ObjectId(id) }, { $set: { status } });
        return res.json(result);
      }

      // Admin & Donor (owner) can update all fields
      const updates = { ...req.body };
      delete updates._id;
      const result = await donationsCollection.updateOne({ _id: ObjectId(id) }, { $set: updates });
      res.json(result);
    });

    // Delete donation (Donor owns it / Admin)
    app.delete('/donations/:id', verifyJWT, async (req, res) => {
      const id = req.params.id;
      const donation = await donationsCollection.findOne({ _id: ObjectId(id) });
      if (!donation) return res.status(404).json({ error: 'Donation not found' });

      if (req.user.role === 'donor' && donation.createdBy !== req.user.email)
        return res.status(403).json({ error: 'Not allowed' });

      const result = await donationsCollection.deleteOne({ _id: ObjectId(id) });
      res.json(result);
    });

    app.listen(port, () => {
      console.log(`Blood Aid Application listening on port ${port}`);
    });
  } catch (err) {
    console.error('MongoDB connection failed', err);
  }
}

run().catch(console.dir);
