const express = require('express');
const axios = require('axios');
const router = express.Router();
// 🗄️ Import the shared connection pool from your server core file
// (Ensure this path correctly targets the file where your mysql2 pool is initialized)
const pool = require('./server'); 

// 🔐 MIDDLEWARE: GET MPESA OAUTH TOKEN
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
    console.error("❌ Safaricom Token Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to generate authentication token" });
  }
};

// 📲 TRIGGER M-PESA STK PUSH
router.post('/stkpush', getMpesaToken, async (req, res) => {
  const { phoneNumber, amount, userId } = req.body; // 💡 Capture userId from frontend request
  const token = req.mpesaToken;

  if (!userId) {
    return res.status(400).json({ error: "Missing identifying userId parameter" });
  }

  // Clean and normalize the phone input safely
  let formattedPhone = phoneNumber.trim().replace(/\s+/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = `254${formattedPhone.slice(1)}`;
  } else if (formattedPhone.startsWith('+')) {
    formattedPhone = formattedPhone.slice(1);
  }

  const shortCode = process.env.MPESA_SHORTCODE || "174379"; 
  const passKey = process.env.MPESA_PASSKEY;

  // 🕒 Generate reliable Kenyan Timezone Timestamp (YYYYMMDDHHMMSS)
  const now = new Date();
  const eatOffset = 3 * 60 * 60 * 1000; 
  const eatDate = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + eatOffset);

  const timestamp = 
    eatDate.getFullYear() +
    ("0" + (eatDate.getMonth() + 1)).slice(-2) +
    ("0" + eatDate.getDate()).slice(-2) +
    ("0" + eatDate.getHours()).slice(-2) +
    ("0" + eatDate.getMinutes()).slice(-2) +
    ("0" + eatDate.getSeconds()).slice(-2);

  const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64');

  const liveBackendUrl = process.env.BACKEND_URL || "https://loan-app-backend-vg4d.onrender.com";
  const finalCallbackUrl = `${liveBackendUrl.replace(/\/$/, '')}/api/mpesa/callback`;

  const stkPayload = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.ceil(amount), 
    PartyA: formattedPhone,
    PartyB: shortCode,
    PhoneNumber: formattedPhone,
    CallBackURL: finalCallbackUrl, 
    AccountReference: `UID-${userId}`, // 💡 Anchor the payment tracking dynamically to the user record
    TransactionDesc: "Loan Settlement Portal"
  };

  try {
    console.log(`🚀 Dispatching STK Push to ${formattedPhone} for KES ${stkPayload.Amount}...`);
    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkPayload,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    res.status(200).json({ 
      message: "STK Push sent successfully!", 
      merchantRequestID: response.data.MerchantRequestID 
    });
  } catch (error) {
    console.error("❌ STK Push Processing Error Details:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to trigger Daraja PIN prompt" });
  }
});

// 📥 SAFARICOM CALLBACK RECEIVER (With Real-Time Database Settlement)
router.post('/callback', async (req, res) => {
  try {
    const callbackData = req.body.Body.stkCallback;
    
    if (callbackData.ResultCode === 0) {
      const metadataItems = callbackData.CallbackMetadata.Item;
      const receipt = metadataItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const amountPaid = metadataItems.find(item => item.Name === 'Amount')?.Value;
      const phone = metadataItems.find(item => item.Name === 'PhoneNumber')?.Value;
      
      // Extract custom AccountReference data string
      const accountRef = callbackData.MerchantRequestID; 
      
      console.log(`✅ Success Callback! Received KES ${amountPaid} from ${phone}. Receipt: ${receipt}`);

      // Parse the dynamic User ID back out from the response strings
      // Alternative standard fallback approach if metadata variation occurs:
      // We can clean phone parameters or matching context strings safely.
      
      // Let's settle the balance gracefully by adding a negative/offset row entry 
      // into the loans list or tracking payments natively.
      // For a dynamic balance framework, adding a 'Payment' record balancing the debt works smoothly:
      
      // 💡 Assuming standard transaction referencing structure:
      // Find user records linked to this phone string or your mapped context IDs.
      const lookupUserSql = "SELECT id FROM users WHERE phone LIKE ?";
      const cleanedSearchPhone = `%${String(phone).slice(-9)}`; // match last 9 digits safely

      pool.query(lookupUserSql, [cleanedSearchPhone], (userErr, userResults) => {
        if (userErr || userResults.length === 0) {
          console.error("❌ Settle Failure: Payment processed but phone signature map to user record failed.", userErr?.message);
          return;
        }

        const calculatedUserId = userResults[0].id;
        const recordPaymentSql = `
          INSERT INTO loans (user_id, loan_type, amount, payment_mode, account_number, status) 
          VALUES (?, 'Repayment', ?, 'M-Pesa', ?, 'Disbursed')
        `;
        
        // 💡 Use a negative amount entry! Because your login & summary routes use SUM(amount), 
        // a negative value here automatically offsets the overall balance correctly.
        const negativeAmountOffset = -Math.abs(parseFloat(amountPaid));

        pool.query(recordPaymentSql, [calculatedUserId, negativeAmountOffset, receipt], (dbErr, dbResult) => {
          if (dbErr) {
            console.error("❌ Database Account Sync Error during Mpesa settlement:", dbErr.message);
          } else {
            console.log(`🎉 Account ID ${calculatedUserId} balance reduced by KES ${amountPaid} via MySQL ledger.`);
          }
        });
      });

    } else {
      console.log(`⚠️ Transaction declined or cancelled by user. Code: ${callbackData.ResultCode}`);
    }
  } catch (err) {
    console.error("❌ Callback Parsing Crash:", err.message);
  }
  res.status(200).send("Callback Received");
});

module.exports = router;