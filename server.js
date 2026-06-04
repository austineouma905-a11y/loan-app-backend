const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
const mpesaRoutes = require('./mpesa');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// 🗄️ DATABASE CONNECTION POOL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, 
  database: process.env.DB_NAME,
  // 💡 Convert port string to base-10 integer immediately to guarantee Aiven doesn't drop connections
  port: parseInt(process.env.DB_PORT, 10) || 24231, 
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false
  }
});

// 🛠️ SAFE DATABASE INITIALIZATION (Data-Preserving)
const initializeDatabase = () => {
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      phone VARCHAR(50),
      password VARCHAR(255) NOT NULL,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error("❌ Error verifying/creating users table:", err.message);
      console.log("⚠️ Continuing initialization of loans table despite users table failure...");
    } else {
      console.log("✅ Users table verified/created successfully.");
    }

    // 💡 REMOVED 'DROP TABLE IF EXISTS loans' TO PREVENT DATA WIPES ON SERVER REBOOTS
    pool.query(`
      CREATE TABLE IF NOT EXISTS loans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        loan_type VARCHAR(255) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        payment_mode VARCHAR(100),
        account_number VARCHAR(100),
        status VARCHAR(50) DEFAULT 'pending',
        date_applied TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, (loanErr) => {
      if (loanErr) {
        console.error("❌ Error verifying/creating loans table:", loanErr.message);
      } else {
        console.log("✅ New loans table verified/built with correct columns successfully!");
      }
    });
  });
};

initializeDatabase();

// 📲 MOUNT DARAJA M-PESA ROUTES
app.use('/api/mpesa', mpesaRoutes); 

// 📝 SIGNUP ROUTE
app.post('/api/signup', async (req, res) => {
  console.log("👉 Registration request processing:", req.body);
  const { firstName, lastName, email, phone, password } = req.body;
  
  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const sql = "INSERT INTO users (first_name, last_name, email, phone, password) VALUES (?, ?, ?, ?, ?)";
    
    pool.query(sql, [firstName, lastName, email, phone, hashedPassword], (err, result) => {
      if (err) {
        console.error("❌ SQL Registration Error:", err.message);
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ message: "This email address is already registered!" });
        }
        return res.status(500).json({ message: "Internal server data persistence error." });
      }
      
      res.status(201).json({ 
        message: "Account synchronized to MySQL successfully!",
        loanId: `LNX-2026-${result.insertId}`,
        userId: result.insertId,
        loanBalance: 0
      });
    });
  } catch (error) {
    res.status(500).json({ message: "Error securing your account profile information." });
  }
});

// 🔑 LOGIN ROUTE (Safe Multi-Query Evaluation)
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const query = "SELECT id, first_name, last_name, email, phone, password FROM users WHERE email = ?";
    
  pool.query(query, [email], async (err, results) => {
    if (err) {
      console.error("❌ SQL Authentication Error:", err.message);
      return res.status(500).json({ message: 'Database query execution failure.' });
    }

    if (results.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password!' });
    }

    const user = results[0];
    
    try {
      const match = await bcrypt.compare(password, user.password);
      if (!match) { 
        return res.status(401).json({ message: 'Invalid username or password!' });
      }

      // Fetch up-to-date loan balance automatically from the loans table entries
      const balanceQuery = "SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status = 'Disbursed'";
      
      pool.query(balanceQuery, [user.id], (balanceErr, balanceResults) => {
        if (balanceErr) {
          console.error("❌ SQL Balance Query Error:", balanceErr.message);
          return res.status(500).json({ message: 'Failed to balance account summaries.' });
        }

        const currentBalance = balanceResults[0].total_balance || 0;

        res.status(200).json({
          message: 'Login authorized via MySQL!',
          name: `${user.first_name} ${user.last_name}`,
          email: user.email,
          phone: user.phone,
          loanId: `LNX-2026-${user.id}`,
          userId: user.id,
          loanBalance: parseFloat(currentBalance)
        });
      });
    } catch (bcryptErr) {
      console.error("❌ Bcrypt evaluation exception:", bcryptErr);
      return res.status(500).json({ message: "Profile access configuration error." });
    }
  });
});

// 💰 LOANS APPLICATION ROUTE
app.post('/api/loans', (req, res) => {
  const { userId, loanType, amount, paymentMode, accountNumber } = req.body;
  
  const insertLoanQuery = "INSERT INTO loans (user_id, loan_type, amount, payment_mode, account_number, status) VALUES (?, ?, ?, ?, ?, 'Disbursed')";
    
  pool.query(insertLoanQuery, [userId, loanType, amount, paymentMode, accountNumber], (err, result) => {
    if (err) {
      console.error("❌ SQL Insert Loan Error:", err.message);
      return res.status(500).json({ message: "Failed to record loan" });
    }

    // Instantly calculate the fresh new balance to give right back to your frontend state
    const getNewBalanceQuery = "SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status = 'Disbursed'";
    pool.query(getNewBalanceQuery, [userId], (balanceErr, balanceResult) => {
      if (balanceErr) {
        console.error("❌ SQL Fetching New Balance Error:", balanceErr.message);
        return res.status(500).json({ message: "Loan saved, but failed to fetch updated balance details." });
      }

      const newTotalBalance = balanceResult[0].total_balance || 0;
      return res.status(200).json({
        message: "Loan processed successfully",
        newTotalBalance: parseFloat(newTotalBalance)
      });
    });
  });
});

// 📊 DASHBOARD SUMMARY ROUTE
app.get('/api/dashboard-summary/:userId', (req, res) => {
  const userId = req.params.userId;

  if (!userId) {
    return res.status(400).json({ message: "User identification parameter missing." });
  }

  const totalBorrowedSql = "SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status = 'Disbursed'";
  const userLoansHistorySql = "SELECT id, loan_type, amount, payment_mode, status, date_applied FROM loans WHERE user_id = ? ORDER BY date_applied DESC";
  
  pool.query(totalBorrowedSql, [userId], (err, balanceResults) => {
    if (err) {
      console.error("❌ Error calculating aggregated totals:", err.message);
      return res.status(500).json({ message: "Database execution failure on total balance." });
    }

    pool.query(userLoansHistorySql, [userId], (errHistory, historyResults) => {
      if (errHistory) {
        console.error("❌ Error fetching loan logs:", errHistory.message);
        return res.status(500).json({ message: "Database execution failure on history." });
      }
      const calculatedTotal = balanceResults[0].total_balance || 0;
      res.status(200).json({
        success: true,
        totalBorrowedBalance: parseFloat(calculatedTotal),
        borrowedLoansList: historyResults
      });
    });
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));