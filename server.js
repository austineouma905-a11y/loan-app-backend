const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, 
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3307,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.query(`
  CREATE TABLE IF NOT EXISTS loans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT NOT NULL,
    loanType VARCHAR(255) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) console.error("Error creating tables:", err);
  else console.log("Database tables verified/created successfully.");
});

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

app.post('/api/login', (req, res) => {
  console.log("👉 Verification tracking for account:", req.body.email);
  const { email, password } = req.body;
  
  const query = 'SELECT id, first_name, last_name, email, phone, password FROM users WHERE email = ?';
  
  pool.query(query, [email], async (err, results) => {
    if (err) {
      console.error("❌ SQL Authentication Error:", err.message);
      return res.status(500).json({ message: 'Database query execution failure.' });
    }

    if (results.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password!' });
    }

    const user = results[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) { 
      return res.status(401).json({ message: 'Invalid username or password!' });
    }

    const balanceQuery = 'SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ?';
    
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
  });
});

app.post('/api/loans', (req, res) => {
  console.log("👉 New Loan request processing:", req.body);
  const { userId, loanType, amount, paymentMode, accountNumber } = req.body;

  if (!userId || !loanType || !amount || !accountNumber) {
    return res.status(400).json({ message: "Missing required loan verification metadata fields." });
  }

  const sql = "INSERT INTO loans (user_id, loan_type, amount, payment_mode, account_number) VALUES (?, ?, ?, ?, ?)";
  pool.query(sql, [userId, loanType, amount, paymentMode, accountNumber], (err, result) => {
    if (err) {
      console.error("❌ SQL Loan Entry Error:", err.message);
      return res.status(500).json({ message: "Failed to persist loan application request records." });
    }
    const sumSql = "SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ?";
    
    pool.query(sumSql, [userId], (sumErr, sumResults) => {
      if (sumErr) {
        console.error("❌ SQL Sum Calculation Failure:", sumErr.message);
        return res.status(500).json({ message: "Loan saved, but dashboard metrics tracking failed." });
      }

      const freshTotal = sumResults[0].total_balance || 0;
      res.status(201).json({
        message: "Loan submission completely locked into DB engines!",
        applicationId: result.insertId,
        status: "Disbursement In Progress",
        newTotalBalance: parseFloat(freshTotal) 
      });
    });
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

app.get('/api/dashboard-summary/:userId', (req, res) => {
  const userId = req.params.userId;

  if (!userId) {
    return res.status(400).json({ message: "User identification parameter missing." });
  }

  // Query A: Calculate the dynamic total sum of all borrowed amounts for this user
  const totalBorrowedSql = "SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ?";
  const userLoansHistorySql = "SELECT id, loan_type, amount, payment_mode, date_applied FROM loans WHERE user_id = ? ORDER BY date_applied DESC";
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
        borrowedLoansList: historyResults // Array of all their active/past loan entries
      });
    });
  });
});