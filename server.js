const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const app = express();
app.use(cors()); app.use(express.json());
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
app.get('/', (req,res)=>res.send('LFH Razorpay backend running'));
app.post('/create-order', async (req,res)=>{
  try{
    const amount = Math.round(Number(req.body.amount || 0));
    if(!amount || amount < 1) return res.status(400).json({error:'Invalid amount'});
    const order = await razorpay.orders.create({ amount: amount*100, currency:'INR', receipt:req.body.receipt || ('LFH_'+Date.now()), payment_capture:1, notes:req.body.notes || {} });
    res.json(order);
  }catch(e){res.status(500).json({error:e.message})}
});

app.post('/refund-payment', async (req,res)=>{
  try{
    const paymentId = req.body.payment_id || req.body.paymentId;
    if(!paymentId) return res.status(400).json({error:'Payment ID missing'});
    const amount = Math.round(Number(req.body.amount || 0));
    const payload = { notes: req.body.notes || {} };
    // amount rupees me aaye to paise me convert. Amount empty ho to full refund.
    if(amount > 0) payload.amount = amount * 100;
    const refund = await razorpay.payments.refund(paymentId, payload);
    res.json(refund);
  }catch(e){res.status(500).json({error:e.message})}
});

app.post('/verify-payment', (req,res)=>{
  try{
    const {razorpay_order_id, razorpay_payment_id, razorpay_signature} = req.body;
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
    res.json({verified: expected === razorpay_signature});
  }catch(e){res.status(500).json({error:e.message})}
});
app.listen(process.env.PORT || 3000, ()=>console.log('LFH backend ready'));
