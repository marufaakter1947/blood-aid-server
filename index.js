require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
  })
);
app.use(express.json());

// Firebase admin
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(decoded)),
});

const client = new MongoClient(process.env.MONGO_URI);

// jwt verify
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

    // role middleware
    const verifyAdmin = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.email });
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "Admin only" });
      }
      next();
    };

    app.post("/users", async (req, res) => {
      const user = req.body;

      const existing = await usersCollection.findOne({ email: user.email });

      const updateDoc = {
        name: user.name,
        photoURL: user.photoURL || user.avatar || "",
        role: user.role || "donor",
        status: user.status || "active",
        bloodGroup: user.bloodGroup,
        district: user.district,
        upazila: user.upazila,
        lastLogin: new Date(),
      };

      if (existing) {
        await usersCollection.updateOne(
          { email: user.email },
          { $set: updateDoc }
        );
        return res.send({ success: true, updated: true });
      }

      const newUser = {
        email: user.email,
        createdAt: new Date(),
        ...updateDoc,
      };

      await usersCollection.insertOne(newUser);
      res.send({ success: true, created: true });
    });

    const verifyAdminOrVolunteer = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.email });

      if (!user) return res.status(401).send({ message: "Unauthorized" });

      if (user.role === "admin" || user.role === "volunteer") {
        req.userRole = user.role;
        return next();
      }

      return res.status(403).send({ message: "Forbidden" });
    };

    //users role
    app.get("/users/role", async (req, res) => {
      const email = req.query.email; // frontend should send ?email=user@example.com
      if (!email)
        return res
          .status(400)
          .json({ success: false, message: "Email required" });

      const user = await usersCollection.findOne({ email });
      if (!user)
        return res
          .status(404)
          .json({ success: false, message: "User not found" });

      res.json({ success: true, role: user.role });
    });

    // login user
    app.get("/users/me", verifyJWT, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.email });
      res.send(user);
    });

    // update profile
    app.patch("/users/profile", verifyJWT, async (req, res) => {
      const updateData = req.body;

      const result = await usersCollection.updateOne(
        { email: req.email },
        { $set: updateData }
      );

      res.send(result);
    });

    // get all donner
    app.get("/donors", async (req, res) => {
      const result = await usersCollection
        .find({ role: "donor", status: "active" })
        .project({ password: 0 })
        .toArray();

      res.send(result);
    });

    // Search donor
    app.get("/donors/search", async (req, res) => {
      try {
        const { bloodGroup, district, upazila } = req.query;

        const query = {
          role: "donor",
          status: "active",
        };

        if (bloodGroup) {
          query.bloodGroup = bloodGroup;
        }

        if (district) {
          query.district = district;
        }

        if (upazila) {
          query.upazila = upazila;
        }

        const donors = await usersCollection.find(query).toArray();

        res.json(donors);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to fetch donors" });
      }
    });

    // donation request
    app.post("/donation-requests", verifyJWT, async (req, res) => {
      try {
        const {
          requesterName,
          requesterEmail,
          recipientName,
          recipientDistrict,
          recipientUpazila,
          hospitalName,
          address,
          bloodGroup,
          donationDate,
          donationTime,
          message,
        } = req.body;

        //chekcing of bloked user
        const user = await usersCollection.findOne({ email: requesterEmail });
        if (!user || user.status !== "active") {
          return res.status(403).json({
            success: false,
            message: "Blocked users cannot create donation requests",
          });
        }

        const newRequest = {
          requesterName,
          requesterEmail,
          recipientName,
          recipientDistrict,
          recipientUpazila,
          hospitalName,
          address,
          bloodGroup,
          donationDate,
          donationTime,
          message,
          status: "pending",
          createdAt: new Date(),
        };

        const result = await requestsCollection.insertOne(newRequest);
        res.status(201).json({ success: true, data: newRequest });
      } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server error" });
      }
    });

    // get all donation request
    app.get("/donation-requests", verifyJWT, async (req, res) => {
      const requests = await requestsCollection.find().toArray();
      res.send(requests);
    });
    // recent 3 request
    app.get("/donation-requests/recent", verifyJWT, async (req, res) => {
      try {
        const email = req.email;

        const requests = await requestsCollection
          .find({ requesterEmail: email })
          .sort({ createdAt: -1 })
          .limit(3)
          .toArray();

        res.send(requests);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to load requests" });
      }
    });

    // All my donation requests
    app.get("/donation-requests/my", verifyJWT, async (req, res) => {
      try {
        const email = req.email;

        const result = await requestsCollection
          .find({ requesterEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch donation requests" });
      }
    });

    app.get("/donation-requests/public", async (req, res) => {
      try {
        const requests = await requestsCollection
          .find({ status: "pending" })
          .sort({ donationDate: 1 })
          .toArray();

        res.json(requests);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch donation requests" });
      }
    });

    // Delete donation requests
    app.delete("/donation-requests/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;

      const user = await usersCollection.findOne({ email: req.email });
      if (!user) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const query = { _id: new ObjectId(id) };

      if (user.role !== "admin") {
        query.requesterEmail = req.email;
      }

      const result = await requestsCollection.deleteOne(query);

      if (result.deletedCount === 0) {
        return res.status(403).json({
          message: "Not allowed or already deleted",
        });
      }

      res.json({ success: true });
    });

    // get single donation request
    app.get("/donation-requests/:id", verifyJWT, async (req, res) => {
      try {
        const { id } = req.params;

        const request = await requestsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request) {
          return res.status(404).send({ message: "Request not found" });
        }

        res.send(request);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch request" });
      }
    });

    // donation request
    app.patch("/donation-requests/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;
      const updateData = { ...req.body };

      // check if user is admin
      const user = await usersCollection.findOne({ email: req.email });
      const filter = { _id: new ObjectId(id) };

      if (user.role !== "admin") {
        filter.requesterEmail = req.email;
      }

      // remove immutable fields
      delete updateData._id;
      delete updateData.requesterName;
      delete updateData.requesterEmail;
      delete updateData.status;
      delete updateData.donorInfo;

      const result = await requestsCollection.updateOne(filter, {
        $set: updateData,
      });

      if (!result.modifiedCount) {
        return res
          .status(404)
          .send({ message: "Donation request not found or no changes made" });
      }

      const updatedRequest = await requestsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send({ success: true, data: updatedRequest });
    });

    // All users
    app.get(
      "/admin/users",
      verifyJWT,
      verifyAdminOrVolunteer,
      async (req, res) => {
        try {
          if (req.userRole === "admin") {
            const users = await usersCollection.find().toArray(); // full data for admin
            return res.send(users);
          } else if (req.userRole === "volunteer") {
            const users = await usersCollection
              .find({}, { projection: { _id: 1, name: 1, email: 1, role: 1 } }) // limited fields
              .toArray();
            return res.send(users);
          }
        } catch (err) {
          console.error(err);
          return res.status(500).send({ message: "Failed to fetch users" });
        }
      }
    );

    // Admin- update role
    app.patch("/admin/role", verifyJWT, verifyAdmin, async (req, res) => {
      const { email, role } = req.body;

      const allowedRoles = ["donor", "volunteer", "admin"];
      if (!allowedRoles.includes(role)) {
        return res.status(400).send({ message: "Invalid role" });
      }

      if (req.email === email) {
        return res
          .status(403)
          .send({ message: "You cannot change your own role" });
      }
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "User not found" });
      }

      res.send({ success: true, modifiedCount: result.modifiedCount });
    });

    // Update status
    app.patch("/admin/status", verifyJWT, verifyAdmin, async (req, res) => {
      const { email, status } = req.body;

      const allowedStatus = ["active", "blocked"];
      if (!allowedStatus.includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }

      const result = await usersCollection.updateOne(
        { email },
        { $set: { status } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "User not found" });
      }

      res.send({ success: true, modifiedCount: result.modifiedCount });
    });

    // total donation requests
    app.get(
      "/admin/donation-requests/count",
      verifyJWT,
      verifyAdminOrVolunteer,
      async (req, res) => {
        const count = await requestsCollection.countDocuments();
        res.send({ count });
      }
    );

    app.patch(
      "/donation-requests/update-status/:id",
      verifyJWT,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body;

        if (!["inprogress", "done", "canceled"].includes(status)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid status" });
        }

        const user = await usersCollection.findOne({ email: req.email });
        if (!user)
          return res
            .status(404)
            .json({ success: false, message: "User not found" });

        const request = await requestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!request)
          return res
            .status(404)
            .json({ success: false, message: "Request not found" });

        // role
        if (user.role === "donor") {
          if (request.requesterEmail !== req.email) {
            return res
              .status(403)
              .json({ success: false, message: "Not allowed" });
          }
          if (request.status !== "inprogress") {
            return res
              .status(400)
              .json({
                success: false,
                message: "Can only update inprogress requests",
              });
          }
        }

        if (user.role === "volunteer") {
          if (request.status !== "inprogress") {
            return res
              .status(400)
              .json({
                success: false,
                message: "Can only update inprogress requests",
              });
          }
        }

        if (user.role === "admin") {
          if (request.status === "pending" && status === "inprogress") {
          } else if (
            request.status === "inprogress" &&
            ["done", "canceled"].includes(status)
          ) {
          } else {
            return res
              .status(400)
              .json({ success: false, message: "Invalid status change" });
          }
        }

        // Update status
        const result = await requestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, updatedAt: new Date() } }
        );

        res.json({ success: true, modifiedCount: result.modifiedCount });
      }
    );

    // Funding endpoints
    // Create a Stripe checkout session
    app.post("/api/funding/create-checkout-session", async (req, res) => {
      try {
        const { amount, name } = req.body; // amount in BDT or convert to smallest currency unit
        if (!amount || amount <= 0) {
          return res.status(400).json({ message: "Invalid amount" });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "bdt",
                product_data: {
                  name: `Donation by ${name || "Anonymous"}`,
                },
                unit_amount: Math.round(amount * 100),
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${process.env.CLIENT_DOMAIN}/funding/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_DOMAIN}/funding/cancel`,
        });

        res.json({ url: session.url });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Stripe session creation failed" });
      }
    });
    // Confirm Stripe payment after checkout
    app.post("/api/funding/confirm-payment", async (req, res) => {
      const { sessionId } = req.body;
      if (!sessionId)
        return res
          .status(400)
          .json({ success: false, message: "Session ID required" });

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== "paid") {
          return res
            .status(400)
            .json({ success: false, message: "Payment not completed" });
        }

        const db = client.db("bloodAidDB");
        const fundsCollection = db.collection("funds");

        // Check if already saved
        const existing = await fundsCollection.findOne({ sessionId });
        if (existing)
          return res.json({ success: true, message: "Already recorded" });

        const newFund = {
          name: session.customer_details?.name || "Anonymous",
          email: session.customer_details?.email || "",
          amount: session.amount_total / 100,
          date: new Date().toISOString().split("T")[0],
          sessionId,
        };

        await fundsCollection.insertOne(newFund);
        res.json({ success: true, data: newFund });
      } catch (err) {
        console.error(err);
        res
          .status(500)
          .json({ success: false, message: "Payment verification failed" });
      }
    });

    // api funding
    app.post("/api/funding/record-payment", async (req, res) => {
      try {
        const { name, amount } = req.body;

        if (!name || !amount)
          return res.status(400).json({ message: "Invalid data" });

        const newFund = {
          name,
          amount,
          date: new Date().toISOString().split("T")[0],
        };

        const db = client.db("bloodAidDB");
        const fundsCollection = db.collection("funds");

        await fundsCollection.insertOne(newFund);

        res.json({ success: true, data: newFund });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to record payment" });
      }
    });

    // funding
    app.get("/api/funding", async (req, res) => {
      try {
        const db = client.db("bloodAidDB");
        const fundsCollection = db.collection("funds");
        const funds = await fundsCollection.find().sort({ date: -1 }).toArray();
        res.json(funds);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to fetch funds" });
      }
    });
    //funding total
    app.get("/api/funding/total", async (req, res) => {
      try {
        const db = client.db("bloodAidDB");
        const fundsCollection = db.collection("funds");

        const result = await fundsCollection
          .aggregate([
            {
              $group: {
                _id: null,
                total: { $sum: "$amount" },
              },
            },
          ])
          .toArray();

        const total = result[0]?.total || 0;
        res.json({ total });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to fetch total funds" });
      }
    });

    console.log("BloodAid Server Running ");
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
