const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const mpesaRoutes = require('./mpesa');
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

const promisePool = pool.promise();
const RESET_CODE_TTL_MINUTES = parseInt(process.env.RESET_CODE_TTL_MINUTES, 10) || 15;
const RESET_VERIFIED_TTL_MINUTES = parseInt(process.env.RESET_VERIFIED_TTL_MINUTES, 10) || 10;

const normalizeEmail = (email = '') => String(email).trim().toLowerCase();
const generateResetCode = () => Math.floor(1000 + Math.random() * 9000).toString();
const getResetOtp = (value) => String(value || '').trim();
const isValidResetOtp = (value) => /^\d{4}$/.test(value);

const ensureColumn = (table, column, definition, afterColumn) => {
  const afterClause = afterColumn ? ` AFTER ${afterColumn}` : '';
  pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}${afterClause}`, (err) => {
    if (!err) {
      console.log(`Column ${table}.${column} added successfully.`);
      return;
    }

    if (err.errno === 1060 || err.code === 'ER_DUP_FIELDNAME') {
      console.log(`Column ${table}.${column} verified.`);
      return;
    }

    console.error(`Unexpected database structure error for ${table}.${column}:`, err.message);
  });
};

const cleanEnvValue = (value = '', removeWhitespace = false) => {
  const cleaned = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  return removeWhitespace ? cleaned.replace(/\s/g, '') : cleaned;
};

const getEmailConfig = () => ({
  emailUser: cleanEnvValue(process.env.EMAIL_USER),
  emailPass: cleanEnvValue(process.env.EMAIL_PASS, true),
  emailFrom: cleanEnvValue(process.env.EMAIL_FROM),
  resendApiKey: cleanEnvValue(process.env.RESEND_API_KEY)
});

const createMailTransporter = () => {
  const { emailUser, emailPass } = getEmailConfig();

  if (!emailUser || !emailPass) {
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    connectionTimeout: 10000,
    auth: {
      user: emailUser,
      pass: emailPass
    },
    tls: {
      rejectUnauthorized: false
    }
  });
};

const hasEmailDeliveryConfig = () => {
  const { emailUser, emailPass, resendApiKey } = getEmailConfig();
  return Boolean(resendApiKey || (emailUser && emailPass));
};

const sendEmail = async ({ to, subject, html }) => {
  const { emailUser, emailFrom, resendApiKey } = getEmailConfig();

  if (resendApiKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: emailFrom || 'Loan App <onboarding@resend.dev>',
        to,
        subject,
        html
      })
    });

    const responseBody = await response.text();
    let payload = {};

    try {
      payload = responseBody ? JSON.parse(responseBody) : {};
    } catch (parseError) {
      payload = { message: responseBody };
    }

    if (!response.ok) {
      const error = new Error(payload.message || payload.error?.message || `Resend API failed with status ${response.status}`);
      error.provider = 'resend';
      error.status = response.status;
      error.details = payload;
      throw error;
    }

    return { provider: 'resend', id: payload.id };
  }

  const transporter = createMailTransporter();

  if (!transporter) {
    throw new Error('Email delivery is not configured on the server.');
  }

  await transporter.sendMail({
    from: emailFrom || emailUser,
    to,
    subject,
    html
  });

  return { provider: 'smtp' };
};

const initializeDatabase = () => {
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      phone VARCHAR(50),
      password VARCHAR(255) NOT NULL,
      reset_code VARCHAR(10) DEFAULT NULL,
      reset_code_expires_at DATETIME DEFAULT NULL,
      reset_verified_until DATETIME DEFAULT NULL,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error("❌ Error verifying/creating users table:", err.message);
    } else {
      console.log("✅ Users table verified/created successfully.");
      ensureColumn('users', 'reset_code', 'VARCHAR(10) DEFAULT NULL', 'password');
      ensureColumn('users', 'reset_code_expires_at', 'DATETIME DEFAULT NULL');
      ensureColumn('users', 'reset_verified_until', 'DATETIME DEFAULT NULL');
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
        console.log("✅ New loans table verified/built with correct columns successfully!");
      }
    });
  });
};

initializeDatabase();

app.use('/api/mpesa', mpesaRoutes); 

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

// 1. FORGOT PASSWORD REQUEST - send a short-lived 4-digit code to the registered email.
app.post('/api/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  console.log(`Password reset requested for: ${email || 'missing email'}`);

  if (!email) {
    return res.status(400).json({ message: "Please enter your registered email address." });
  }

  if (!hasEmailDeliveryConfig()) {
    return res.status(500).json({ message: "Email delivery is not configured on the server." });
  }

  try {
    const [users] = await promisePool.query(
      "SELECT id, first_name, email FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
      [email]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "This email address is not registered with us!" });
    }

    const user = users[0];
    const resetCode = generateResetCode();

    await promisePool.query(
      `UPDATE users
       SET reset_code = ?,
           reset_code_expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE),
           reset_verified_until = NULL
       WHERE id = ?`,
      [resetCode, RESET_CODE_TTL_MINUTES, user.id]
    );

    const mailOptions = {
      to: user.email,
      subject: 'Verification Code - Loan Application',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #2c3e50; text-align: center;">Secure Password Reset</h2>
          <p>Hello${user.first_name ? ` ${user.first_name}` : ''},</p>
          <p>Use this single-use verification code to reset your password:</p>
          <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #16a085; border: 1px dashed #bdc3c7; border-radius: 4px; margin: 20px 0;">
            ${resetCode}
          </div>
          <p style="color: #7f8c8d; font-size: 12px;">This code expires in ${RESET_CODE_TTL_MINUTES} minutes. If you did not request a reset, ignore this email.</p>
        </div>
      `
    };

    try {
      const delivery = await sendEmail(mailOptions);
      console.log(`Reset verification mail dispatched to ${user.email} via ${delivery.provider}`);
      return res.status(200).json({ message: "Verification code sent to your registered email." });
    } catch (mailError) {
      await promisePool.query(
        "UPDATE users SET reset_code = NULL, reset_code_expires_at = NULL, reset_verified_until = NULL WHERE id = ?",
        [user.id]
      );
      console.error("Password Reset Mail Dispatch Exception:", {
        provider: mailError.provider || 'smtp',
        code: mailError.code,
        command: mailError.command,
        status: mailError.status,
        responseCode: mailError.responseCode,
        details: mailError.details,
        message: mailError.message
      });
      return res.status(500).json({ message: "Failed to send the verification code. Check server email settings." });
    }
  } catch (error) {
    console.error("Forgot Password Error:", error.message);
    return res.status(500).json({ message: "Database query execution failure." });
  }
});

// 2. VERIFY THE 4-DIGIT OTP
app.post('/api/verify-otp', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = getResetOtp(req.body.otp || req.body.code);
  console.log(`Verifying OTP for: ${email || 'missing email'}`);

  if (!email || !isValidResetOtp(otp)) {
    return res.status(400).json({ message: "Enter the 4-digit code sent to your email." });
  }

  try {
    const [users] = await promisePool.query(
      `SELECT id
       FROM users
       WHERE LOWER(email) = LOWER(?)
         AND reset_code = ?
         AND reset_code_expires_at IS NOT NULL
         AND reset_code_expires_at > NOW()
       LIMIT 1`,
      [email, otp]
    );

    if (users.length === 0) {
      return res.status(400).json({ message: "Invalid or expired OTP code." });
    }

    await promisePool.query(
      "UPDATE users SET reset_verified_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?",
      [RESET_VERIFIED_TTL_MINUTES, users[0].id]
    );

    return res.status(200).json({ message: "Successful verification." });
  } catch (error) {
    console.error("SQL Verify OTP Error:", error.message);
    return res.status(500).json({ message: "Database verification failure." });
  }
});

// 3. RESET PASSWORD ROUTE - only works after OTP verification or with a valid OTP.
app.post('/api/reset-password', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const newPassword = req.body.newPassword || req.body.password;
  const otp = getResetOtp(req.body.otp || req.body.code);
  console.log(`Resetting password for: ${email || 'missing email'}`);

  if (!email || !newPassword) {
    return res.status(400).json({ message: "Email and new password are required." });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters long." });
  }

  if (otp && !isValidResetOtp(otp)) {
    return res.status(400).json({ message: "Enter the 4-digit code sent to your email." });
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const params = otp ? [hashedPassword, email, otp] : [hashedPassword, email];
    const resetCondition = otp
      ? `LOWER(email) = LOWER(?)
         AND reset_code = ?
         AND reset_code_expires_at IS NOT NULL
         AND reset_code_expires_at > NOW()`
      : `LOWER(email) = LOWER(?)
         AND reset_verified_until IS NOT NULL
         AND reset_verified_until > NOW()`;

    const [result] = await promisePool.query(
      `UPDATE users
       SET password = ?,
           reset_code = NULL,
           reset_code_expires_at = NULL,
           reset_verified_until = NULL
       WHERE ${resetCondition}`,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ message: "Please verify the OTP code before resetting your password." });
    }

    return res.status(200).json({ message: "Password updated successfully!" });
  } catch (error) {
    console.error("SQL Reset Password Error:", error.message);
    return res.status(500).json({ message: "Failed to update password." });
  }
});

app.post('/api/loans', (req, res) => {
  const { userId, loanType, amount, paymentMode, accountNumber } = req.body;
  const insertLoanQuery = "INSERT INTO loans (user_id, loan_type, amount, payment_mode, account_number, status) VALUES (?, ?, ?, ?, ?, 'Disbursed')";
    
  pool.query(insertLoanQuery, [userId, loanType, amount, paymentMode, accountNumber], (err, result) => {
    if (err) {
      console.error("❌ SQL Insert Loan Error:", err.message);
      return res.status(500).json({ message: "Failed to record loan" });
    }
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

app.post('/api/mpesa/stkpush', async (req, res) => {
  const { phoneNumber, amount, accountReference, transactionDesc } = req.body;

  const generatedMpesaPassword = "STUB_PASSWORD"; 
  const currentTimestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

  const stkPushPayload = {
    BusinessShortCode: process.env.MPESA_SHORTCODE || "174379",
    Password: generatedMpesaPassword,
    Timestamp: currentTimestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: phoneNumber,
    PartyB: process.env.MPESA_SHORTCODE || "174379",
    PhoneNumber: phoneNumber,
    CallBackURL: process.env.MPESA_CALLBACK_URL || "https://example.com/callback",
    AccountReference: accountReference || "LoanRepayment",
    TransactionDesc: transactionDesc || "Loan Repayment"
  };

  res.status(200).json({ message: "Payload generated successfully", payload: stkPushPayload });
});

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

module.exports = pool;
