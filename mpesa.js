const express = require('express');
const axios = require('axios');
const { randomUUID } = require('crypto');
const router = express.Router();
require('dotenv').config();
const pool = require('./db');

const getNonNegativeInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const getMinimumInt = (value, fallback, minimum) => {
  const parsed = parseInt(value, 10);
  const resolved = Number.isInteger(parsed) ? parsed : fallback;
  return Math.max(resolved, minimum);
};

const MPESA_BASE_URL = String(process.env.MPESA_BASE_URL || 'https://sandbox.safaricom.co.ke').replace(/\/$/, '');
const MPESA_TIMEOUT_MS = getMinimumInt(process.env.MPESA_TIMEOUT_MS, 20000, 5000);
const MPESA_TOKEN_RETRIES = getNonNegativeInt(process.env.MPESA_TOKEN_RETRIES, 2);
const MPESA_STK_RETRIES = getNonNegativeInt(process.env.MPESA_STK_RETRIES, 0);
const MPESA_RETRY_NETWORK_STK = String(process.env.MPESA_RETRY_NETWORK_STK || '').toLowerCase() === 'true';
const MPESA_STK_DUPLICATE_WINDOW_MS = getMinimumInt(process.env.MPESA_STK_DUPLICATE_WINDOW_MS, 90000, 10000);
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

let cachedToken = null;
let cachedTokenExpiresAt = 0;
let tokenRequestPromise = null;
const recentStkRequests = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getRetryDelayMs = (attempt) => {
  const baseDelay = 500 * (2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(baseDelay + jitter, 5000);
};

const getMpesaErrorDetails = (error) => ({
  status: error.response?.status,
  data: error.response?.data,
  code: error.code,
  message: error.message
});

const isTransientMpesaError = (error) => {
  if (error.retryable === false) return false;

  const status = error.response?.status;
  if (!status) return true;

  return status === 408 || status === 429 || status >= 500;
};

const requestWithRetry = async (requestFn, { label, retries, retryWhen = isTransientMpesaError }) => {
  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await requestFn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt > retries || !retryWhen(error)) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attempt);
      console.warn(`${label} failed on attempt ${attempt}. Retrying in ${delayMs}ms...`, getMpesaErrorDetails(error));
      await sleep(delayMs);
    }
  }

  throw lastError;
};

const getMpesaTimestamp = () => {
  const eatDate = new Date(Date.now() + (3 * 60 * 60 * 1000));

  return (
    eatDate.getUTCFullYear() +
    String(eatDate.getUTCMonth() + 1).padStart(2, '0') +
    String(eatDate.getUTCDate()).padStart(2, '0') +
    String(eatDate.getUTCHours()).padStart(2, '0') +
    String(eatDate.getUTCMinutes()).padStart(2, '0') +
    String(eatDate.getUTCSeconds()).padStart(2, '0')
  );
};

const normalizePhoneNumber = (phoneNumber) => {
  let formattedPhone = String(phoneNumber || '').trim().replace(/[^\d]/g, '');

  if (formattedPhone.startsWith('0')) {
    formattedPhone = `254${formattedPhone.slice(1)}`;
  } else if (!formattedPhone.startsWith('254') && formattedPhone.length === 9) {
    formattedPhone = `254${formattedPhone}`;
  }

  return /^254(?:7|1)\d{8}$/.test(formattedPhone) ? formattedPhone : null;
};

const normalizeDarajaText = (value, fallback, maxLength) => {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ');

  return cleaned.slice(0, maxLength) || fallback.slice(0, maxLength);
};

const cleanupRecentStkRequests = () => {
  const now = Date.now();

  for (const [key, entry] of recentStkRequests.entries()) {
    if (entry.expiresAt <= now) {
      recentStkRequests.delete(key);
    }
  }
};

const getRecentStkRequest = (key) => {
  const entry = recentStkRequests.get(key);

  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    recentStkRequests.delete(key);
    return null;
  }

  return entry;
};

const rememberStkRequest = (key, entry) => {
  cleanupRecentStkRequests();
  recentStkRequests.set(key, {
    ...entry,
    expiresAt: Date.now() + MPESA_STK_DUPLICATE_WINDOW_MS
  });
};

const clearRecentStkRequest = (key) => {
  recentStkRequests.delete(key);
};

const getStkRequestKey = ({ userId, formattedPhone, amount, accountReference }) => (
  [
    userId || 'anonymous',
    formattedPhone,
    amount,
    accountReference
  ].join('|')
);

const getCallbackUrl = () => {
  const liveBackendUrl = String(process.env.BACKEND_URL || '').trim();

  if (!liveBackendUrl) {
    const error = new Error('BACKEND_URL is not configured');
    error.statusCode = 500;
    error.publicMessage = 'M-Pesa callback URL is not configured on the server.';
    throw error;
  }

  try {
    const callbackUrl = new URL('/api/mpesa/callback', liveBackendUrl.endsWith('/') ? liveBackendUrl : `${liveBackendUrl}/`);

    if (!['http:', 'https:'].includes(callbackUrl.protocol)) {
      throw new Error('Callback URL must use HTTP or HTTPS');
    }

    return callbackUrl.toString();
  } catch (parseError) {
    const error = new Error(`Invalid BACKEND_URL: ${parseError.message}`);
    error.statusCode = 500;
    error.publicMessage = 'M-Pesa callback URL is invalid on the server.';
    throw error;
  }
};

const clearCachedMpesaToken = () => {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
};

const requestMpesaAccessToken = async () => {
  const consumerKey = String(process.env.MPESA_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.MPESA_CONSUMER_SECRET || '').trim();
  
  if (!consumerKey || !consumerSecret) {
    console.error("❌ Missing M-Pesa credentials:", { 
      hasKey: !!consumerKey, 
      hasSecret: !!consumerSecret 
    });
    const error = new Error('M-Pesa API credentials not configured on server');
    error.statusCode = 500;
    error.publicMessage = 'M-Pesa API credentials are not configured on the server.';
    error.retryable = false;
    throw error;
  }
  
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  return requestWithRetry(async () => {
    console.log("🔐 Requesting M-Pesa token from Safaricom...");
    const response = await axios.get(
      `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      { 
        headers: { Authorization: `Basic ${auth}` },
        timeout: MPESA_TIMEOUT_MS
      }
    );
    
    if (response.data && response.data.access_token) {
      const expiresInMs = (parseInt(response.data.expires_in, 10) || 3599) * 1000;
      cachedToken = response.data.access_token;
      cachedTokenExpiresAt = Date.now() + expiresInMs;
      console.log("✅ M-Pesa token generated successfully");
      return cachedToken;
    }

    const error = new Error('Invalid token response from M-Pesa service');
    error.response = { data: response.data, status: response.status };
    error.retryable = false;
    throw error;
  }, {
    label: 'M-Pesa token request',
    retries: MPESA_TOKEN_RETRIES
  });
};

const getMpesaAccessToken = async ({ forceRefresh = false } = {}) => {
  const tokenIsValid = cachedToken && cachedTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now();

  if (!forceRefresh && tokenIsValid) {
    return cachedToken;
  }

  if (forceRefresh) {
    clearCachedMpesaToken();
  }

  if (!tokenRequestPromise) {
    tokenRequestPromise = requestMpesaAccessToken().finally(() => {
      tokenRequestPromise = null;
    });
  }

  return tokenRequestPromise;
};

const getMpesaToken = async (req, res, next) => {
  try {
    req.mpesaToken = await getMpesaAccessToken();
    next();
  } catch (error) {
    console.error("❌ Safaricom Token Error:", getMpesaErrorDetails(error));
    res.status(error.statusCode || 502).json({
      error: error.publicMessage || "Failed to generate M-Pesa authentication token. Please try again."
    });
  }
};

const sendStkPushRequest = async (stkPayload, token) => requestWithRetry(async () => axios.post(
  `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
  stkPayload,
  {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: MPESA_TIMEOUT_MS
  }
), {
  label: 'M-Pesa STK push request',
  retries: MPESA_STK_RETRIES,
  retryWhen: (error) => {
    if (error.response?.status === 401 || error.response?.status === 403) return false;

    if (!error.response?.status) {
      return MPESA_RETRY_NETWORK_STK;
    }

    return isTransientMpesaError(error);
  }
});

router.post('/stkpush', getMpesaToken, async (req, res) => {
  const { phoneNumber, amount, userId, accountReference, transactionDesc } = req.body;
  const token = req.mpesaToken;
  const requestId = randomUUID();
  let duplicateKey;

  // Validate required inputs
  if (!phoneNumber || !amount || !accountReference) {
    return res.status(400).json({ 
      error: "Missing required parameters: phoneNumber, amount, accountReference" 
    });
  }

  if (!token) {
    return res.status(500).json({ 
      error: "Failed to obtain M-Pesa access token" 
    });
  }

  // Validate amount
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ 
      error: "Invalid amount. Must be a positive number." 
    });
  }

  try {
    const formattedPhone = normalizePhoneNumber(phoneNumber);
    if (!formattedPhone) {
      return res.status(400).json({
        error: "Invalid phone number. Use a valid Kenyan M-Pesa number, for example 0712345678."
      });
    }

    const shortCode = String(process.env.MPESA_SHORTCODE || '174379').trim();
    const passKey = String(process.env.MPESA_PASSKEY || '').trim();

    if (!passKey) {
      console.error("❌ MPESA_PASSKEY not configured");
      return res.status(500).json({ error: "M-Pesa passkey not configured on server" });
    }

    const timestamp = getMpesaTimestamp();
    const passwordString = `${shortCode}${passKey}${timestamp}`;
    const password = Buffer.from(passwordString).toString('base64');
    const finalCallbackUrl = getCallbackUrl();

    const stkPayload = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.ceil(numAmount),
      PartyA: formattedPhone,
      PartyB: shortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: finalCallbackUrl,
      AccountReference: normalizeDarajaText(accountReference, 'Loan', 12),
      TransactionDesc: normalizeDarajaText(transactionDesc, "Loan Pay", 13)
    };
    duplicateKey = getStkRequestKey({
      userId,
      formattedPhone,
      amount: stkPayload.Amount,
      accountReference: stkPayload.AccountReference
    });
    const recentRequest = getRecentStkRequest(duplicateKey);

    if (recentRequest) {
      console.warn(`[${requestId}] Duplicate STK Push suppressed. Existing request=${recentRequest.requestId}, status=${recentRequest.status}`);
      return res.status(200).json({
        message: recentRequest.checkoutRequestID
          ? "M-Pesa prompt already sent. Check your phone for the existing prompt."
          : "M-Pesa payment request is already being initiated. Check your phone shortly.",
        merchantRequestID: recentRequest.merchantRequestID,
        checkoutRequestID: recentRequest.checkoutRequestID,
        requestId: recentRequest.requestId,
        deduplicated: true
      });
    }

    rememberStkRequest(duplicateKey, {
      requestId,
      status: 'initiating'
    });

    console.log(`[${requestId}] STK Push: shortcode=${shortCode}, phone=${formattedPhone}, amount=${stkPayload.Amount}, account=${stkPayload.AccountReference}`);

    let response;
    try {
      response = await sendStkPushRequest(stkPayload, token);
    } catch (error) {
      if (error.response?.status !== 401 && error.response?.status !== 403) {
        throw error;
      }

      console.warn(`[${requestId}] Cached M-Pesa token was rejected. Refreshing token and retrying once...`, getMpesaErrorDetails(error));
      const freshToken = await getMpesaAccessToken({ forceRefresh: true });
      response = await sendStkPushRequest(stkPayload, freshToken);
    }

    if (response.data && String(response.data.ResponseCode) === '0') {
      console.log(`[${requestId}] ✅ STK Push accepted:`, response.data);
      rememberStkRequest(duplicateKey, {
        requestId,
        status: 'accepted',
        merchantRequestID: response.data.MerchantRequestID,
        checkoutRequestID: response.data.CheckoutRequestID
      });

      if (userId) {
        try {
          await pool.promise().query(
            `INSERT INTO loans (
              user_id, loan_type, amount, transaction_type, payment_mode,
              account_number, provider_request_id, checkout_request_id, status
            ) VALUES (?, 'Repayment', ?, 'Repayment', 'M-Pesa', ?, ?, ?, 'Pending')`,
            [
              userId,
              -Math.abs(stkPayload.Amount),
              response.data.CheckoutRequestID || response.data.MerchantRequestID || 'Pending M-Pesa',
              response.data.MerchantRequestID,
              response.data.CheckoutRequestID
            ]
          );
        } catch (ledgerError) {
          console.error(`[${requestId}] M-Pesa pending ledger insert failed:`, ledgerError.message);
        }
      }

      res.status(200).json({
        message: "STK Push sent successfully! Check your phone for M-Pesa prompt.",
        merchantRequestID: response.data.MerchantRequestID,
        checkoutRequestID: response.data.CheckoutRequestID,
        requestId
      });
    } else {
      console.error(`[${requestId}] ❌ STK Push failed - Response:`, response.data);
      clearRecentStkRequest(duplicateKey);
      res.status(400).json({
        error: response.data?.ResponseDescription || "Failed to send STK Push",
        responseCode: response.data?.ResponseCode,
        requestId
      });
    }
  } catch (error) {
    console.error(`[${requestId}] ❌ STK Push Error:`, getMpesaErrorDetails(error));
    if (typeof duplicateKey !== 'undefined') {
      clearRecentStkRequest(duplicateKey);
    }
    res.status(error.statusCode || 502).json({
      error: error.publicMessage || error.response?.data?.errorMessage || error.response?.data?.ResponseDescription || "Failed to process STK Push request. Please try again.",
      providerStatus: error.response?.status,
      providerCode: error.response?.data?.errorCode || error.response?.data?.ResponseCode,
      requestId
    });
  }
});

router.post('/callback', async (req, res) => {
  try {
    const callbackData = req.body?.Body?.stkCallback;

    if (!callbackData) {
      console.warn("⚠️ M-Pesa callback received without stkCallback payload.");
      return res.status(200).send("Callback Received");
    }

    const merchantRequestID = callbackData.MerchantRequestID || null;
    const checkoutRequestID = callbackData.CheckoutRequestID || null;
    
    if (callbackData.ResultCode === 0) {
      const metadataItems = callbackData.CallbackMetadata?.Item || [];
      const receipt = metadataItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const amountPaid = metadataItems.find(item => item.Name === 'Amount')?.Value;
      const phone = metadataItems.find(item => item.Name === 'PhoneNumber')?.Value;
      const parsedAmountPaid = parseFloat(amountPaid);
      const negativeAmountOffset = Number.isFinite(parsedAmountPaid) ? -Math.abs(parsedAmountPaid) : 0;
      
      console.log(`✅ Success Callback! Received KES ${amountPaid} from ${phone}. Receipt: ${receipt}`);

      const [updateResult] = await pool.promise().query(
        `UPDATE loans
         SET status = 'Completed',
             amount = ?,
             account_number = ?,
             receipt_number = ?,
             completed_at = NOW(),
             failure_reason = NULL
         WHERE transaction_type = 'Repayment'
           AND status = 'Pending'
           AND (checkout_request_id = ? OR provider_request_id = ?)
         LIMIT 1`,
        [
          negativeAmountOffset,
          receipt || checkoutRequestID || merchantRequestID,
          receipt,
          checkoutRequestID,
          merchantRequestID
        ]
      );

      if (updateResult.affectedRows > 0) {
        console.log(`🎉 Pending M-Pesa repayment marked completed. Receipt: ${receipt}`);
        return res.status(200).send("Callback Received");
      }
      
      const lookupUserSql = "SELECT id FROM users WHERE phone LIKE ?";
      const cleanedSearchPhone = `%${String(phone).slice(-9)}`; 

      const [userResults] = await pool.promise().query(lookupUserSql, [cleanedSearchPhone]);

      if (userResults.length > 0) {
        const calculatedUserId = userResults[0].id;
        const recordPaymentSql = `
          INSERT INTO loans (
            user_id, loan_type, amount, transaction_type, payment_mode,
            account_number, receipt_number, provider_request_id, checkout_request_id,
            status, completed_at
          ) VALUES (?, 'Repayment', ?, 'Repayment', 'M-Pesa', ?, ?, ?, ?, 'Completed', NOW())
        `;

        await pool.promise().query(recordPaymentSql, [
          calculatedUserId,
          negativeAmountOffset,
          receipt || checkoutRequestID || merchantRequestID,
          receipt,
          merchantRequestID,
          checkoutRequestID
        ]);
        console.log(`🎉 Account ID ${calculatedUserId} balance reduced by KES ${amountPaid} via MySQL ledger.`);
      } else {
        console.error("❌ Settle Failure: Payment processed but phone signature map to user record failed.");
      }
    } else {
      await pool.promise().query(
        `UPDATE loans
         SET status = 'Failed',
             failure_reason = ?,
             completed_at = NOW()
         WHERE transaction_type = 'Repayment'
           AND status = 'Pending'
           AND (checkout_request_id = ? OR provider_request_id = ?)
         LIMIT 1`,
        [
          callbackData.ResultDesc || `M-Pesa callback failed with code ${callbackData.ResultCode}`,
          checkoutRequestID,
          merchantRequestID
        ]
      );
      console.log(`⚠️ Transaction declined or cancelled by user. Code: ${callbackData.ResultCode}`);
    }
  } catch (err) {
    console.error("❌ Callback Parsing Crash:", err.message);
  }
  res.status(200).send("Callback Received");
});

module.exports = router;
