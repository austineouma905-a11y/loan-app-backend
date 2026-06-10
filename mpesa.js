const express = require('express');
const axios = require('axios');
const router = express.Router();
require('dotenv').config();
const pool = require('./db');

const getMpesaToken = async (req, res, next) => {
  const consumerKey = String(process.env.MPESA_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.MPESA_CONSUMER_SECRET || '').trim();
  
  if (!consumerKey || !consumerSecret) {
    console.error("❌ Missing M-Pesa credentials:", { 
      hasKey: !!consumerKey, 
      hasSecret: !!consumerSecret 
    });
    return res.status(500).json({ error: "M-Pesa API credentials not configured on server" });
  }
  
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  try {
    console.log("🔐 Requesting M-Pesa token from Safaricom...");
    const response = await axios.get(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { 
        headers: { Authorization: `Basic ${auth}` },
        timeout: 10000
      }
    );
    
    if (response.data && response.data.access_token) {
      req.mpesaToken = response.data.access_token;
      console.log("✅ M-Pesa token generated successfully");
      next();
    } else {
      console.error("❌ No access token in response:", response.data);
      res.status(500).json({ error: "Invalid token response from M-Pesa service" });
    }
  } catch (error) {
    console.error("❌ Safaricom Token Error:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    res.status(500).json({ error: "Failed to generate authentication token. Check server logs." });
  }
};
router.post('/stkpush', getMpesaToken, async (req, res) => {
  const { phoneNumber, amount, userId, accountReference, transactionDesc } = req.body;
  const token = req.mpesaToken;

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
    let formattedPhone = String(phoneNumber).trim().replace(/\s+/g, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = `254${formattedPhone.slice(1)}`;
    } else if (formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.replace('+', '');
    } else if (!formattedPhone.startsWith('254')) {
      formattedPhone = `254${formattedPhone}`;
    }

    const shortCode = String(process.env.MPESA_SHORTCODE || '174379').trim();
    const passKey = String(process.env.MPESA_PASSKEY || '').trim();

    if (!passKey) {
      console.error("❌ MPESA_PASSKEY not configured");
      return res.status(500).json({ error: "M-Pesa passkey not configured on server" });
    }

    const now = new Date();
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const eatTime = new Date(utcTime + (3 * 60 * 60 * 1000));

    const timestamp = 
      eatTime.getFullYear() +
      String(eatTime.getMonth() + 1).padStart(2, '0') +
      String(eatTime.getDate()).padStart(2, '0') +
      String(eatTime.getHours()).padStart(2, '0') +
      String(eatTime.getMinutes()).padStart(2, '0') +
      String(eatTime.getSeconds()).padStart(2, '0');

    const passwordString = `${shortCode}${passKey}${timestamp}`;
    const password = Buffer.from(passwordString).toString('base64');

    const liveBackendUrl = String(process.env.BACKEND_URL || '').trim();
    const finalCallbackUrl = `${liveBackendUrl.replace(/\/$/, '')}/api/mpesa/callback`;

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
      AccountReference: String(accountReference).trim(),
      TransactionDesc: String(transactionDesc || "Loan Settlement Portal").trim()
    };

    console.log(`📋 STK Push Debug Info:`);
    console.log(`   ShortCode: ${shortCode}`);
    console.log(`   Timestamp: ${timestamp}`);
    console.log(`   Password String: ${passwordString}`);
    console.log(`   Password (base64): ${password}`);
    console.log(`   Phone: ${formattedPhone}`);
    console.log(`   Amount: ${stkPayload.Amount}`);
    console.log(`🚀 Sending STK Push to ${formattedPhone} for KES ${stkPayload.Amount}...`);

    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    if (response.data && response.data.ResponseCode === '0') {
      console.log("✅ STK Push successful:", response.data);
      res.status(200).json({
        message: "STK Push sent successfully! Check your phone for M-Pesa prompt.",
        merchantRequestID: response.data.MerchantRequestID,
        checkoutRequestID: response.data.CheckoutRequestID
      });
    } else {
      console.error("❌ STK Push failed - Response:", response.data);
      res.status(400).json({
        error: response.data?.ResponseDescription || "Failed to send STK Push",
        responseCode: response.data?.ResponseCode
      });
    }
  } catch (error) {
    console.error("❌ STK Push Error:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    res.status(500).json({
      error: error.response?.data?.errorMessage || "Failed to process STK Push request",
      details: error.message
    });
  }
});

router.post('/callback', async (req, res) => {
  try {
    const callbackData = req.body.Body.stkCallback;
    
    if (callbackData.ResultCode === 0) {
      const metadataItems = callbackData.CallbackMetadata.Item;
      const receipt = metadataItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const amountPaid = metadataItems.find(item => item.Name === 'Amount')?.Value;
      const phone = metadataItems.find(item => item.Name === 'PhoneNumber')?.Value;
      
      console.log(`✅ Success Callback! Received KES ${amountPaid} from ${phone}. Receipt: ${receipt}`);
      
      const lookupUserSql = "SELECT id FROM users WHERE phone LIKE ?";
      const cleanedSearchPhone = `%${String(phone).slice(-9)}`; 

      const [userResults] = await pool.promise().query(lookupUserSql, [cleanedSearchPhone]);

      if (userResults.length > 0) {
        const calculatedUserId = userResults[0].id;
        const recordPaymentSql = `
          INSERT INTO loans (user_id, loan_type, amount, payment_mode, account_number, status) 
          VALUES (?, 'Repayment', ?, 'M-Pesa', ?, 'Disbursed')
        `;
        const negativeAmountOffset = -Math.abs(parseFloat(amountPaid));

        await pool.promise().query(recordPaymentSql, [calculatedUserId, negativeAmountOffset, receipt]);
        console.log(`🎉 Account ID ${calculatedUserId} balance reduced by KES ${amountPaid} via MySQL ledger.`);
      } else {
        console.error("❌ Settle Failure: Payment processed but phone signature map to user record failed.");
      }
    } else {
      console.log(`⚠️ Transaction declined or cancelled by user. Code: ${callbackData.ResultCode}`);
    }
  } catch (err) {
    console.error("❌ Callback Parsing Crash:", err.message);
  }
  res.status(200).send("Callback Received");
});

module.exports = router;