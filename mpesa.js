const express = require('express');
const axios = require('axios');
const router = express.Router();

// 💡 Helper Middleware: Generate secure Safaricom OAuth Token
const getMpesaToken = async (req, res, next) => {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  try {
    const response = await axios.get(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      {
        headers: { Authorization: `Basic ${auth}` },
      }
    );
    req.mpesaToken = response.data.access_token;
    next();
  } catch (error) {
    console.error("❌ Safaricom Token Error:", error.message);
    res.status(500).json({ error: "Failed to generate authentication token" });
  }
};

// 📲 Route 1: Initiate the STK Push PIN Prompt
router.post('/stkpush', getMpesaToken, async (req, res) => {
  const { phoneNumber, amount } = req.body;
  const token = req.mpesaToken;

  // Format local phone numbers safely to 254XXXXXXXXX standard
  let formattedPhone = phoneNumber.trim().replace(/\s+/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = `254${formattedPhone.slice(1)}`;
  } else if (formattedPhone.startsWith('+')) {
    formattedPhone = formattedPhone.slice(1);
  }

  const shortCode = process.env.MPESA_SHORTCODE || "174379"; 
  const passKey = process.env.MPESA_PASSKEY;
  
  // Create Timestamp: YYYYMMDDHHmmss
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64');

  const stkPayload = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.ceil(amount), // Ensure integer values
    PartyA: formattedPhone,
    PartyB: shortCode,
    PhoneNumber: formattedPhone,
    CallBackURL: "https://your-render-backend-url.onrender.com/api/mpesa/callback", // ⚠️ Replace with your live Render URL
    AccountReference: "OstoLoanRepay",
    TransactionDesc: "Loan Settlement Portal"
  };

  try {
    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkPayload,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.status(200).json({ message: "STK Push sent successfully!", merchantRequestID: response.data.MerchantRequestID });
  } catch (error) {
    console.error("❌ STK Push Processing Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to trigger Daraja PIN prompt" });
  }
});

// 📡 Route 2: Safaricom Webhook Callback Receiver
router.post('/callback', async (req, res) => {
  try {
    const callbackData = req.body.Body.stkCallback;
    
    if (callbackData.ResultCode === 0) {
      const metadataItems = callbackData.CallbackMetadata.Item;
      const receipt = metadataItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const amountPaid = metadataItems.find(item => item.Name === 'Amount')?.Value;
      const phone = metadataItems.find(item => item.Name === 'PhoneNumber')?.Value;

      console.log(`✅ Success! Received KES ${amountPaid} from ${phone}. Receipt: ${receipt}`);

      // 🗄️ TODO: Connect your Aiven MySQL Pool loop to clear out account balances here!
      // await db.query("UPDATE loans SET balance = balance - ? WHERE phone = ?", [amountPaid, phone]);

    } else {
      console.log(`⚠️ Transaction declined or cancelled by user. Code: ${callbackData.ResultCode}`);
    }
  } catch (err) {
    console.error("❌ Callback Parsing Crash:", err.message);
  }
  
  // Safaricom strictly requires a clean 200 OK acknowledgment
  res.status(200).send("Callback Received");
});

module.exports = router;