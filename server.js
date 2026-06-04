const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const mpesaRoutes = require('./mpesa');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// In-memory global store to hold validation OTP codes temporarily
const otpVerificationStore = new Map();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, 
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT, 10) || 24231, 
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false
  },
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

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
    } else {
      console.log("✅ Users table verified/created successfully.");
    }
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
        console.log("✅ New loans table verified/built successfully!");
      }
    });
  });
};

initializeDatabase();
app.use('/api/mpesa', mpesaRoutes); 

app.post('/api/signup', async (req, res) => {
  const { firstName, lastName, email, phone, password } = req.body;
  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const sql = "INSERT INTO users (first_name, last_name, email, phone, password) VALUES (?, ?, ?, ?, ?)";
    
    pool.query(sql, [firstName, lastName, email, phone, hashedPassword], (err, result) => {
      if (err) {
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
  const { email, password } = req.body;
  const query = "SELECT id, first_name, last_name, email, phone, password FROM users WHERE email = ?";
    
  pool.query(query, [email], async (err, results) => {
    if (err) {
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
      const balanceQuery = "SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status = 'Disbursed'";
      
      pool.query(balanceQuery, [user.id], (balanceErr, balanceResults) => {
        if (balanceErr) {
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
      return res.status(500).json({ message: "Profile access configuration error." });
    }
  });
});

/* 📡 Trigger 6-Digit Validation OTP via System Console Logs */
app.post('/api/forgot-password', (req, res) => {
  const { email } = req.body;
  const checkEmailQuery = "SELECT id FROM users WHERE email = ?";

  pool.query(checkEmailQuery, [email], (err, results) => {
    if (err) {
      return res.status(500).json({ message: "Database engine breakdown." });
    }
    if (results.length === 0) {
      return res.status(404).json({ message: "Email trace not found in records." });
    }

    const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Save generated token linked to this email address (Valid for 10 minutes)
    otpVerificationStore.set(email, {
      code: generatedOtp,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    
    console.log(`\n==============🔒 SYSTEM SECURITY DISPATCH 🔒==============`);
    console.log(`🔑 PASSWORD RESET REQUEST INITIATED FOR: ${email}`);
    console.log(`➔ YOUR VALIDATION OTP VERIFICATION CODE IS: [ ${generatedOtp} ]`);
    console.log(`==========================================================\n`);

    return res.status(200).json({ 
      message: "Security code broadcasted successfully! Enter the OTP to finalize updates." 
    });
  });
});

/* 🛠️ Verify the OTP and Commit New Password updates to MySQL */
app.post('/api/reset-password-verify', async (req, res) => {
  const { email, otpCode, newPassword } = req.body;
  const record = otpVerificationStore.get(email);

  if (!record) {
    return res.status(400).json({ message: "No active verification session found for this user context." });
  }
  if (Date.now() > record.expiresAt) {
    otpVerificationStore.delete(email);
    return res.status(400).json({ message: "Verification session has expired. Request a new OTP." });
  }
  if (record.code !== otpCode.trim()) {
    return res.status(400).json({ message: "Invalid verification code sequence match failed." });
  }

  try {
    const saltRounds = 10;
    const newHashedPassword = await bcrypt.hash(newPassword, saltRounds);
    const updatePasswordSql = "UPDATE users SET password = ? WHERE email = ?";

    pool.query(updatePasswordSql, [newHashedPassword, email], (updateErr) => {
      if (updateErr) {
        return res.status(500).json({ message: "Failed to persist new security configuration changes." });
      }
      
      // Successfully consumed OTP
      otpVerificationStore.delete(email);
      return res.status(200).json({ message: "Credentials successfully updated inside MySQL!" });
    });
  } catch (ex) {
    return res.status(500).json({ message: "System failure hashing password matrices safely." });
  }
});

app.post('/api/loans', (req, res) => {
  const { userId, loanType, amount, paymentMode, accountNumber } = req.body;
  const insertLoanQuery = "INSERT INTO loans (user_id, loan_type, amount, payment_mode, account_number, status) VALUES (?, ?, ?, ?, ?, 'Disbursed')";
    
  pool.query(insertLoanQuery, [userId, loanType, amount, paymentMode, accountNumber], (err) => {
    if (err) {
      return res.status(500).json({ message: "Failed to record loan" });
    }
    const getNewBalanceQuery = "SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status = 'Disbursed'";
    pool.query(getNewBalanceQuery, [userId], (balanceErr, balanceResult) => {
      if (balanceErr) {
        return res.status(500).json({ message: "Loan saved, but balance updates failed." });
      }
      const newTotalBalance = balanceResult[0].total_balance || 0;
      return res.status(200).json({
        message: "Loan processed successfully",
        newTotalBalance: parseFloat(newTotalBalance)
      });
    });
  });
});

app.get('/api/dashboard-summary/:userId', (req, res) => {
  const userId = req.params.userId;
  if (!userId) return res.status(400).json({ message: "User identification missing." });

  const totalBorrowedSql = "SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status = 'Disbursed'";
  const userLoansHistorySql = "SELECT id, loan_type, amount, payment_mode, status, date_applied FROM loans WHERE user_id = ? ORDER BY date_applied DESC";
  
  pool.query(totalBorrowedSql, [userId], (err, balanceResults) => {
    if (err) return res.status(500).json({ message: "Database execution failure." });

    pool.query(userLoansHistorySql, [userId], (errHistory, historyResults) => {
      if (errHistory) return res.status(500).json({ message: "Database execution failure." });
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

module.exports = pool;