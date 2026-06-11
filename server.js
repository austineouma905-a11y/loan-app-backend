const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const pool = require('./db');
const mpesaRoutes = require('./mpesa');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret']
}));

app.use(express.json());

const promisePool = pool.promise();
const RESET_CODE_TTL_MINUTES = parseInt(process.env.RESET_CODE_TTL_MINUTES, 10) || 15;
const RESET_VERIFIED_TTL_MINUTES = parseInt(process.env.RESET_VERIFIED_TTL_MINUTES, 10) || 10;
const MPESA_BASE_URL = String(process.env.MPESA_BASE_URL || 'https://sandbox.safaricom.co.ke').replace(/\/$/, '');
const MPESA_TIMEOUT_MS = Math.max(parseInt(process.env.MPESA_TIMEOUT_MS, 10) || 20000, 5000);
const POSTED_LEDGER_STATUS_SQL = "('Disbursed', 'Completed')";

const normalizeEmail = (email = '') => String(email).trim().toLowerCase();
const generateResetCode = () => Math.floor(1000 + Math.random() * 9000).toString();
const getResetOtp = (value) => String(value || '').trim();
const isValidResetOtp = (value) => /^\d{4}$/.test(value);
const getPositiveNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getPositiveInt = (value, fallback = 1) => {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getFutureDueDate = (durationMonths) => {
  const dueDate = new Date();
  dueDate.setMonth(dueDate.getMonth() + durationMonths);
  return dueDate.toISOString().slice(0, 10);
};

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
  emailProvider: cleanEnvValue(process.env.EMAIL_PROVIDER).toLowerCase(),
  emailUser: cleanEnvValue(process.env.EMAIL_USER),
  emailPass: cleanEnvValue(process.env.EMAIL_PASS, true),
  emailFrom: cleanEnvValue(process.env.EMAIL_FROM),
  resendApiKey: cleanEnvValue(process.env.RESEND_API_KEY),
  brevoSmtpUser: cleanEnvValue(process.env.BREVO_SMTP_USER),
  brevoSmtpPass: cleanEnvValue(process.env.BREVO_SMTP_PASS, true),
  brevoFrom: cleanEnvValue(process.env.BREVO_FROM || process.env.BREVO_SENDER_EMAIL),
  smtpHost: cleanEnvValue(process.env.SMTP_HOST) || 'smtp-relay.brevo.com',
  smtpPort: parseInt(process.env.SMTP_PORT, 10) || 587,
  smtpSecure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true'
});

const isResendTestSender = (from = '') => !from || /onboarding@resend\.dev/i.test(from);

const createMailError = (provider, message, details) => {
  const error = new Error(message);
  error.provider = provider;
  if (details) error.details = details;
  return error;
};

const getEmailDiagnostics = () => {
  const {
    emailProvider,
    emailUser,
    emailPass,
    emailFrom,
    resendApiKey,
    brevoSmtpUser,
    brevoSmtpPass,
    brevoFrom
  } = getEmailConfig();

  const requestedProvider = emailProvider || 'auto';
  const brevoSender = emailFrom || brevoFrom;
  const resendFrom = emailFrom || 'Loan App <onboarding@resend.dev>';
  const brevoReady = Boolean(brevoSmtpUser && brevoSmtpPass && brevoSender);
  const gmailReady = Boolean(emailUser && emailPass);
  const resendReady = Boolean(resendApiKey && !isResendTestSender(resendFrom));
  const canSendToAllUsers = requestedProvider === 'brevo'
    ? brevoReady
    : requestedProvider === 'gmail'
      ? gmailReady
      : requestedProvider === 'resend'
        ? resendReady
        : Boolean(brevoReady || gmailReady || resendReady);

  let activeProvider = null;
  if (requestedProvider === 'auto') {
    activeProvider = brevoReady ? 'brevo' : gmailReady ? 'gmail' : resendReady ? 'resend' : null;
  } else if (canSendToAllUsers) {
    activeProvider = requestedProvider;
  }

  const issues = [];
  const checksBrevo = requestedProvider === 'brevo' || requestedProvider === 'auto';
  const checksResend = requestedProvider === 'resend' || requestedProvider === 'auto';

  if (checksBrevo && (!brevoSmtpUser || !brevoSmtpPass)) {
    issues.push('Brevo SMTP credentials are missing. Set BREVO_SMTP_USER and BREVO_SMTP_PASS.');
  }
  if (checksBrevo && brevoSmtpUser && brevoSmtpPass && !brevoSender) {
    issues.push('Brevo SMTP is set, but EMAIL_FROM or BREVO_FROM is missing. Brevo needs a verified sender address.');
  }
  if (checksResend && resendApiKey && isResendTestSender(resendFrom)) {
    issues.push('Resend is using onboarding@resend.dev, which only sends to verified test recipients.');
  }
  if (!canSendToAllUsers) {
    issues.push('No email provider is fully configured for sending OTPs to all users.');
  }

  return {
    requestedProvider,
    activeProvider,
    canSendToAllUsers,
    providers: {
      brevo: {
        credentialsLoaded: Boolean(brevoSmtpUser && brevoSmtpPass),
        senderConfigured: Boolean(brevoSender),
        ready: brevoReady
      },
      gmail: {
        credentialsLoaded: gmailReady,
        ready: gmailReady
      },
      resend: {
        apiKeyLoaded: Boolean(resendApiKey),
        productionSenderConfigured: Boolean(resendApiKey && !isResendTestSender(resendFrom)),
        ready: resendReady
      }
    },
    issues
  };
};

const createMailTransporter = (provider = 'gmail') => {
  const {
    emailUser,
    emailPass,
    brevoSmtpUser,
    brevoSmtpPass,
    smtpHost,
    smtpPort,
    smtpSecure
  } = getEmailConfig();

  if (provider === 'brevo') {
    if (!brevoSmtpUser || !brevoSmtpPass) {
      return null;
    }

    return nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      connectionTimeout: 10000,
      auth: {
        user: brevoSmtpUser,
        pass: brevoSmtpPass
      }
    });
  }

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

const sendEmail = async ({ to, subject, html }) => {
  const {
    emailProvider,
    emailUser,
    emailPass,
    emailFrom,
    resendApiKey,
    brevoSmtpUser,
    brevoSmtpPass,
    brevoFrom
  } = getEmailConfig();

  const provider = emailProvider || 'auto';
  const canUseBrevo = Boolean(brevoSmtpUser && brevoSmtpPass);
  const canUseGmail = Boolean(emailUser && emailPass);
  const resendFrom = emailFrom || 'Loan App <onboarding@resend.dev>';
  const brevoFromAddress = emailFrom || brevoFrom;
  const candidates = provider === 'auto'
    ? [
        canUseBrevo ? 'brevo' : null,
        canUseGmail ? 'gmail' : null,
        resendApiKey ? 'resend' : null
      ].filter(Boolean)
    : [provider];

  let lastError = null;

  for (const candidate of candidates) {
    try {
      if (candidate === 'brevo') {
        const transporter = createMailTransporter('brevo');

        if (!transporter) {
          throw createMailError('brevo', 'Brevo SMTP delivery is not configured on the server.');
        }
        if (!brevoFromAddress) {
          throw createMailError('brevo', 'Brevo needs EMAIL_FROM or BREVO_FROM set to a verified sender address.');
        }

        await transporter.sendMail({
          from: brevoFromAddress,
          to,
          subject,
          html
        });

        return { provider: 'brevo' };
      }

      if (candidate === 'gmail') {
        const transporter = createMailTransporter('gmail');

        if (!transporter) {
          throw createMailError('gmail', 'Gmail SMTP delivery is not configured on the server.');
        }

        await transporter.sendMail({
          from: emailFrom || emailUser,
          to,
          subject,
          html
        });

        return { provider: 'gmail' };
      }

      if (candidate === 'resend') {
        if (!resendApiKey) {
          throw createMailError('resend', 'Resend API key is not configured on the server.');
        }
        if (isResendTestSender(resendFrom)) {
          throw createMailError('resend', 'Resend test sender only delivers to verified test recipients. Set EMAIL_FROM to a verified sender/domain, or use EMAIL_PROVIDER=brevo.');
        }

        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: resendFrom,
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
          const error = createMailError(
            'resend',
            payload.message || payload.error?.message || `Resend API failed with status ${response.status}`,
            payload
          );
          error.status = response.status;
          throw error;
        }

        return { provider: 'resend', id: payload.id };
      }

      throw createMailError(candidate, `Unknown email provider: ${candidate}`);
    } catch (error) {
      lastError = error;
      if (provider !== 'auto') throw error;
      console.error(`Email delivery via ${candidate} failed:`, {
        provider: error.provider || candidate,
        code: error.code,
        command: error.command,
        status: error.status,
        responseCode: error.responseCode,
        details: error.details,
        message: error.message
      });
    }
  }

  throw lastError || createMailError('email', 'Email delivery is not configured on the server.');
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
        principal_amount DECIMAL(10,2) DEFAULT NULL,
        repayment_amount DECIMAL(10,2) DEFAULT NULL,
        duration_months INT DEFAULT NULL,
        interest_rate DECIMAL(5,2) DEFAULT NULL,
        due_date DATE DEFAULT NULL,
        transaction_type VARCHAR(50) DEFAULT NULL,
        payment_mode VARCHAR(100),
        account_number VARCHAR(100),
        receipt_number VARCHAR(100) DEFAULT NULL,
        provider_request_id VARCHAR(100) DEFAULT NULL,
        checkout_request_id VARCHAR(100) DEFAULT NULL,
        failure_reason VARCHAR(255) DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        date_applied TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, (loanErr) => {
      if (loanErr) {
        console.error("❌ Error verifying/creating loans table:", loanErr.message);
      } else {
        console.log("✅ New loans table verified/built with correct columns successfully!");
        ensureColumn('loans', 'principal_amount', 'DECIMAL(10,2) DEFAULT NULL', 'amount');
        ensureColumn('loans', 'repayment_amount', 'DECIMAL(10,2) DEFAULT NULL', 'principal_amount');
        ensureColumn('loans', 'duration_months', 'INT DEFAULT NULL', 'repayment_amount');
        ensureColumn('loans', 'interest_rate', 'DECIMAL(5,2) DEFAULT NULL', 'duration_months');
        ensureColumn('loans', 'due_date', 'DATE DEFAULT NULL', 'interest_rate');
        ensureColumn('loans', 'transaction_type', 'VARCHAR(50) DEFAULT NULL', 'due_date');
        ensureColumn('loans', 'receipt_number', 'VARCHAR(100) DEFAULT NULL', 'account_number');
        ensureColumn('loans', 'provider_request_id', 'VARCHAR(100) DEFAULT NULL', 'receipt_number');
        ensureColumn('loans', 'checkout_request_id', 'VARCHAR(100) DEFAULT NULL', 'provider_request_id');
        ensureColumn('loans', 'failure_reason', 'VARCHAR(255) DEFAULT NULL', 'checkout_request_id');
        ensureColumn('loans', 'completed_at', 'DATETIME DEFAULT NULL', 'failure_reason');
      }
    });
  });
};

initializeDatabase();

app.use('/api/mpesa', mpesaRoutes);

// Diagnostic health check endpoint
app.get('/api/health', (req, res) => {
  const hasConsumerKey = !!String(process.env.MPESA_CONSUMER_KEY || '').trim();
  const hasConsumerSecret = !!String(process.env.MPESA_CONSUMER_SECRET || '').trim();
  const hasPassKey = !!String(process.env.MPESA_PASSKEY || '').trim();
  const hasShortCode = !!String(process.env.MPESA_SHORTCODE || '').trim();
  const emailDiagnostics = getEmailDiagnostics();

  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    database: 'connected',
    emailConfig: emailDiagnostics,
    mpesaConfig: {
      consumerKeyLoaded: hasConsumerKey,
      consumerSecretLoaded: hasConsumerSecret,
      passKeyLoaded: hasPassKey,
      shortCodeLoaded: hasShortCode,
      shortCode: hasShortCode ? process.env.MPESA_SHORTCODE : 'NOT SET',
      baseUrl: MPESA_BASE_URL,
      backendUrl: process.env.BACKEND_URL || 'NOT SET'
    }
  });
});

app.post('/api/test-mpesa-token', async (req, res) => {
  console.log("🧪 Testing M-Pesa token generation...");
  const axios = require('axios');
  const consumerKey = String(process.env.MPESA_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.MPESA_CONSUMER_SECRET || '').trim();
  
  if (!consumerKey || !consumerSecret) {
    return res.status(400).json({ 
      error: "Missing Consumer Key or Secret in .env",
      consumerKeyLength: consumerKey.length,
      consumerSecretLength: consumerSecret.length
    });
  }

  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    console.log("Auth header length:", auth.length);
    
    const response = await axios.get(
      `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      { 
        headers: { Authorization: `Basic ${auth}` },
        timeout: MPESA_TIMEOUT_MS
      }
    );
    
    res.status(200).json({
      status: 'SUCCESS',
      message: 'M-Pesa token generated successfully',
      token: response.data.access_token.substring(0, 20) + '...',
      expiresIn: response.data.expires_in
    });
  } catch (error) {
    res.status(500).json({
      error: 'Token generation failed',
      status: error.response?.status,
      errorData: error.response?.data,
      errorMessage: error.message,
      hint: 'Check your Consumer Key and Consumer Secret in .env file. Credentials must be registered in Safaricom Daraja portal.'
    });
  }
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
      const balanceQuery = `SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status IN ${POSTED_LEDGER_STATUS_SQL}`;
      
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

  const emailDiagnostics = getEmailDiagnostics();
  if (!emailDiagnostics.canSendToAllUsers) {
    return res.status(500).json({
      message: emailDiagnostics.issues[0] || "Email delivery is not configured on the server.",
      emailConfig: emailDiagnostics
    });
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
      return res.status(500).json({ 
        message: "Failed to send the verification code. Check server email settings.",
        debug: {
          provider: mailError.provider || 'smtp',
          error: mailError.message,
          code: mailError.code,
          details: mailError.details
        }
      });
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
  const {
    userId,
    loanType,
    amount,
    paymentMode,
    accountNumber,
    durationMonths,
    interestRate,
    repaymentAmount,
    dueDate
  } = req.body;
  const principalAmount = getPositiveNumber(amount);
  const resolvedDurationMonths = getPositiveInt(durationMonths, 1);
  const resolvedInterestRate = getPositiveNumber(interestRate);
  const resolvedRepaymentAmount = getPositiveNumber(repaymentAmount, principalAmount);
  const resolvedDueDate = dueDate || getFutureDueDate(resolvedDurationMonths);

  if (!userId || !loanType || !principalAmount || !paymentMode || !accountNumber) {
    return res.status(400).json({ message: "Loan request is missing required fields." });
  }

  const insertLoanQuery = `
    INSERT INTO loans (
      user_id, loan_type, amount, principal_amount, repayment_amount,
      duration_months, interest_rate, due_date, transaction_type,
      payment_mode, account_number, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Loan Disbursement', ?, ?, 'Disbursed')
  `;

  pool.query(insertLoanQuery, [
    userId,
    loanType,
    resolvedRepaymentAmount,
    principalAmount,
    resolvedRepaymentAmount,
    resolvedDurationMonths,
    resolvedInterestRate,
    resolvedDueDate,
    paymentMode,
    accountNumber
  ], (err, result) => {
    if (err) {
      console.error("❌ SQL Insert Loan Error:", err.message);
      return res.status(500).json({ message: "Failed to record loan" });
    }
    const getNewBalanceQuery = `SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status IN ${POSTED_LEDGER_STATUS_SQL}`;
    pool.query(getNewBalanceQuery, [userId], (balanceErr, balanceResult) => {
      if (balanceErr) {
        console.error("❌ SQL Fetching New Balance Error:", balanceErr.message);
        return res.status(500).json({ message: "Loan saved, but failed to fetch updated balance details." });
      }

      const newTotalBalance = balanceResult[0].total_balance || 0;
      return res.status(200).json({
        message: "Loan processed successfully",
        loanId: result.insertId,
        status: 'Disbursed',
        principalAmount,
        repaymentAmount: resolvedRepaymentAmount,
        dueDate: resolvedDueDate,
        newTotalBalance: parseFloat(newTotalBalance)
      });
    });
  });
});
app.post('/api/update-profile', (req, res) => {
  const { userId, firstName, lastName, email, phone } = req.body;

  if (!userId || !firstName || !lastName || !email || !phone) {
    return res.status(400).json({ message: "All profile fields are required." });
  }

  const sql = `
    UPDATE users 
    SET first_name = ?, last_name = ?, email = ?, phone = ? 
    WHERE id = ?
  `;
  const values = [firstName, lastName, email, phone, userId];

  pool.query(sql, values, (err, result) => {
    if (err) {
      console.error("❌ Database update error:", err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ message: "This email or phone number is already registered." });
      }
      return res.status(500).json({ message: "Failed to update profile due to a server error." });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "User not found or no changes made." });
    }

    res.status(200).json({ message: "Profile updated successfully!" });
  });
});

app.post('/api/change-password', async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;

  if (!userId || !currentPassword || !newPassword) {
    return res.status(400).json({ message: 'All fields are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'New password must be at least 8 characters.' });
  }

  try {
    const [users] = await promisePool.query('SELECT password FROM users WHERE id = ? LIMIT 1', [userId]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found.' });

    const match = await bcrypt.compare(currentPassword, users[0].password);
    if (!match) return res.status(401).json({ message: 'Current password is incorrect.' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await promisePool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, userId]);
    return res.status(200).json({ message: 'Password changed successfully!' });
  } catch (error) {
    console.error('Change Password Error:', error.message);
    return res.status(500).json({ message: 'Failed to update password.' });
  }
});

app.get('/api/transactions/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const [transactions] = await promisePool.query(
      `SELECT
         id,
         loan_type,
         amount,
         principal_amount,
         repayment_amount,
         duration_months,
         interest_rate,
         due_date,
         COALESCE(transaction_type, CASE WHEN amount < 0 THEN 'Repayment' ELSE 'Loan Disbursement' END) AS transaction_type,
         payment_mode,
         account_number,
         receipt_number,
         provider_request_id,
         checkout_request_id,
         failure_reason,
         CASE
           WHEN status IN ('Disbursed', 'Completed', 'Paid') THEN 'Completed'
           WHEN status IN ('Failed', 'Cancelled', 'Declined') THEN 'Failed'
           ELSE 'Pending'
         END AS display_status,
         status,
         completed_at,
         date_applied
       FROM loans WHERE user_id = ? ORDER BY date_applied DESC`,
      [userId]
    );
    return res.status(200).json({ transactions });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch transactions.' });
  }
});

app.get('/api/balance/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const [result] = await promisePool.query(
      `SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status IN ${POSTED_LEDGER_STATUS_SQL}`,
      [userId]
    );
    return res.status(200).json({ loanBalance: parseFloat(result[0].total_balance || 0) });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch balance.' });
  }
});

app.get('/api/loans/:userId', (req, res) => {
  const userId = req.params.userId;

  if (!userId) {
    return res.status(400).json({ message: "User identification parameter missing." });
  }

  const totalBorrowedSql = `SELECT SUM(amount) AS total_balance FROM loans WHERE user_id = ? AND status IN ${POSTED_LEDGER_STATUS_SQL}`;
  const userLoansHistorySql = "SELECT id, loan_type, amount, principal_amount, repayment_amount, duration_months, interest_rate, due_date, payment_mode, account_number, receipt_number, status, date_applied FROM loans WHERE user_id = ? ORDER BY date_applied DESC";
  
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

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin123';

const adminAuth = (req, res, next) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) return res.status(401).json({ message: 'Unauthorized' });
  next();
};

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const [users] = await promisePool.query(
      'SELECT id, first_name, last_name, email, phone, createdAt FROM users ORDER BY createdAt DESC'
    );
    res.status(200).json({ users });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch users.' });
  }
});

app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  try {
    const [[userStats]] = await promisePool.query('SELECT COUNT(*) AS totalActiveUsers FROM users');
    const [[loanStats]] = await promisePool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN amount > 0 AND status IN ${POSTED_LEDGER_STATUS_SQL} THEN COALESCE(principal_amount, amount) ELSE 0 END), 0) AS totalDisbursed,
        COALESCE(SUM(CASE WHEN amount < 0 AND status IN ${POSTED_LEDGER_STATUS_SQL} THEN ABS(amount) ELSE 0 END), 0) AS totalRepaid,
        COALESCE(SUM(CASE WHEN status IN ${POSTED_LEDGER_STATUS_SQL} THEN amount ELSE 0 END), 0) AS outstandingBalance,
        COALESCE(SUM(CASE WHEN status NOT IN ${POSTED_LEDGER_STATUS_SQL} AND amount < 0 THEN 1 ELSE 0 END), 0) AS pendingRepayments
      FROM loans
    `);
    const [pendingLoanRequests] = await promisePool.query(`
      SELECT l.id, l.loan_type, l.amount, l.principal_amount, l.repayment_amount,
             l.duration_months, l.interest_rate, l.due_date, l.payment_mode,
             l.account_number, l.status, l.date_applied,
             u.first_name, u.last_name, u.email, u.phone
      FROM loans l
      JOIN users u ON l.user_id = u.id
      WHERE l.amount > 0 AND l.status IN ('Pending', 'Review', 'Processing')
      ORDER BY l.date_applied ASC
      LIMIT 25
    `);

    res.status(200).json({
      totalActiveUsers: Number(userStats.totalActiveUsers || 0),
      totalDisbursed: Number(loanStats.totalDisbursed || 0),
      totalRepaid: Number(loanStats.totalRepaid || 0),
      outstandingBalance: Number(loanStats.outstandingBalance || 0),
      pendingRepayments: Number(loanStats.pendingRepayments || 0),
      pendingLoanRequests
    });
  } catch (error) {
    console.error('Admin analytics error:', error.message);
    res.status(500).json({ message: 'Failed to fetch admin analytics.' });
  }
});

app.get('/api/admin/loans', adminAuth, async (req, res) => {
  try {
    const [loans] = await promisePool.query(`
      SELECT l.id, l.loan_type, l.amount, l.principal_amount, l.repayment_amount,
             l.duration_months, l.interest_rate, l.due_date,
             COALESCE(l.transaction_type, CASE WHEN l.amount < 0 THEN 'Repayment' ELSE 'Loan Disbursement' END) AS transaction_type,
             l.payment_mode, l.account_number, l.receipt_number, l.provider_request_id,
             l.checkout_request_id, l.failure_reason, l.completed_at, l.status, l.date_applied,
             u.first_name, u.last_name, u.email, u.phone
      FROM loans l
      JOIN users u ON l.user_id = u.id
      ORDER BY l.date_applied DESC
    `);
    res.status(200).json({ loans });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch loans.' });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
