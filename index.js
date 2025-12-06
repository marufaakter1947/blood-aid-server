require('dotenv').config(); // <-- load .env first
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;
app.use(express.json());

app.use(
  cors({
    origin: process.env.CLIENT_DOMAIN || '*',
  })
);

// MongoDB connection
const uri = process.env.MONGO_URI;

if (!uri) {
  console.error('MongoDB URI is not defined in .env');
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: { version: '1', strict: true, deprecationErrors: true },
});

async function run() {
  try {
    await client.connect();
    console.log('MongoDB connected successfully');

    const db = client.db('bloodAidDB');
    const usersCollection = db.collection('users');

    // Test route
    app.get('/', (req, res) => {
      res.send('Blood Aid Server is Running');
    });

    // POST /users route
    app.post('/users', async (req, res) => {
      try {
        const user = req.body;

        // Simple validation
        if (!user.email || !user.name) {
          return res.status(400).json({ error: 'Name and email are required' });
        }

        const result = await usersCollection.insertOne(user);
        res.status(201).json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create user' });
      }
    });

    app.listen(port, () => {
      console.log(`Blood Aid Application listening on port ${port}`);
    });
  } catch (err) {
    console.error('MongoDB connection failed', err);
  }
}

run().catch(console.dir);
