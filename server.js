const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const SHIPROCKET_BASE = 'https://apiv2.shiprocket.in/v1/external';
let shiprocketToken = null;
let shiprocketTokenTime = 0;

function n(v, d = 0){ const x = Number(v); return Number.isFinite(x) ? x : d; }
function cleanPhone(v){ return String(v || '').replace(/\D/g,'').slice(-10); }
function safeText(v, fallback=''){ return String(v || fallback || '').trim(); }
function todayDate(){ return new Date().toISOString().slice(0,19).replace('T',' '); }

async function shiprocketLogin(){
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if(!email || !password) throw new Error('Shiprocket credentials missing in Render Environment');
  // Token normally valid around 10 days, but refresh early for safety.
  if(shiprocketToken && (Date.now() - shiprocketTokenTime) < 8*24*60*60*1000) return shiprocketToken;
  const r = await fetch(SHIPROCKET_BASE + '/auth/login', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email, password})
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok || !j.token) throw new Error(j.message || j.error || 'Shiprocket login failed');
  shiprocketToken = j.token;
  shiprocketTokenTime = Date.now();
  return shiprocketToken;
}

async function shiprocketFetch(path, options={}){
  const token = await shiprocketLogin();
  const r = await fetch(SHIPROCKET_BASE + path, {
    ...options,
    headers:{
      'Content-Type':'application/json',
      'Authorization':'Bearer ' + token,
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let j; try{ j = text ? JSON.parse(text) : {}; }catch(e){ j = { raw:text }; }
  if(!r.ok) throw new Error(j.message || j.error || JSON.stringify(j).slice(0,300) || 'Shiprocket API error');
  return j;
}

app.get('/', (req,res)=>res.send('LFH Razorpay + Shiprocket backend running'));

app.post('/create-order', async (req,res)=>{
  try{
    const amount = Math.round(Number(req.body.amount || 0));
    if(!amount || amount < 1) return res.status(400).json({error:'Invalid amount'});
    const order = await razorpay.orders.create({
      amount: amount*100,
      currency:'INR',
      receipt:req.body.receipt || ('LFH_'+Date.now()),
      payment_capture:1,
      notes:req.body.notes || {}
    });
    res.json(order);
  }catch(e){res.status(500).json({error:e.message})}
});

app.post('/refund-payment', async (req,res)=>{
  try{
    const paymentId = req.body.payment_id || req.body.paymentId;
    if(!paymentId) return res.status(400).json({error:'Payment ID missing'});
    const amount = Math.round(Number(req.body.amount || 0));
    const payload = { notes: req.body.notes || {} };
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

// Sirf shipping rate/serviceability check. Isse Shiprocket me order create nahi hota.
app.post('/shipping-rate', async (req,res)=>{
  try{
    const pickup = String(req.body.pickup_pincode || process.env.SHIPROCKET_PICKUP_PINCODE || '481551');
    const delivery = String(req.body.delivery_pincode || req.body.pincode || '').trim();
    const weight = Math.max(0.1, n(req.body.weight, 0.5));
    const cod = req.body.cod === false ? 0 : 1;
    if(!/^\d{6}$/.test(delivery)) return res.status(400).json({error:'Valid delivery pincode missing'});
    const qs = new URLSearchParams({ pickup_postcode:pickup, delivery_postcode:delivery, cod:String(cod), weight:String(weight) });
    const j = await shiprocketFetch('/courier/serviceability/?' + qs.toString(), { method:'GET' });
    const companies = j?.data?.available_courier_companies || [];
    const mapped = companies.map(c=>({
      courier_company_id:c.courier_company_id,
      courier_name:c.courier_name,
      rate:n(c.rate || c.freight_charge,0) + n(c.cod_charges,0),
      freight_charge:n(c.freight_charge || c.rate,0),
      cod_charges:n(c.cod_charges,0),
      etd:c.etd || c.estimated_delivery_days || ''
    })).filter(c=>c.rate>0).sort((a,b)=>a.rate-b.rate);
    res.json({success:true, pickup_pincode:pickup, delivery_pincode:delivery, weight, cod:!!cod, best:mapped[0]||null, couriers:mapped.slice(0,8), raw:j});
  }catch(e){res.status(500).json({success:false,error:e.message})}
});

function buildShiprocketPayload(orderId, order){
  const c = order.customer || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const phone = cleanPhone(c.mobile || c.phone);
  const codAmount = Math.max(0, n(order.cod, 0));
  const totalWeight = Math.max(0.1, n(order.totalWeight, items.reduce((s,i)=>s+(n(i.weight,0.5)||0.5)*(n(i.qty,1)||1),0.5)));
  const address = safeText(c.address, 'Lovely Fashion House Customer Address');
  const city = safeText(c.city, 'Lamta');
  const state = safeText(c.state, 'Madhya Pradesh');
  const pincode = safeText(c.pincode || c.pin || c.postcode);
  if(!phone) throw new Error('Customer mobile missing');
  if(!/^\d{6}$/.test(pincode)) throw new Error('Customer pincode missing/invalid');
  if(!items.length) throw new Error('Order items missing');
  const orderItems = items.map((i,idx)=>({
    name: safeText(i.name, 'LFH Product'),
    sku: safeText(i.id || i.sku || ('LFH-SKU-' + (idx+1))),
    units: Math.max(1, Math.round(n(i.qty,1))),
    selling_price: n(i.price,0) || n(order.total,0) || 1,
    discount: 0,
    tax: 0,
    hsn: safeText(i.hsn || '')
  }));
  return {
    order_id: safeText(order.orderId || orderId),
    order_date: todayDate(),
    pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
    channel_id: '',
    comment: 'Lovely Fashion House website order',
    billing_customer_name: safeText(c.name, 'Customer'),
    billing_last_name: '',
    billing_address: address.slice(0,190),
    billing_address_2: safeText(c.landmark || '').slice(0,190),
    billing_city: city,
    billing_pincode: pincode,
    billing_state: state,
    billing_country: 'India',
    billing_email: safeText(c.email, 'customer@example.com'),
    billing_phone: phone,
    shipping_is_billing: true,
    order_items: orderItems,
    payment_method: codAmount > 0 ? 'COD' : 'Prepaid',
    shipping_charges: n(order.delivery, 0),
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: 0,
    sub_total: codAmount > 0 ? codAmount : n(order.total,0),
    length: n(order.length, 10) || 10,
    breadth: n(order.breadth, 10) || 10,
    height: n(order.height, 4) || 4,
    weight: totalWeight
  };
}

// Admin button se Shiprocket me order create hoga. Customer payment ke baad automatic nahi.
app.post('/shiprocket/create-order', async (req,res)=>{
  try{
    const orderId = req.body.orderId || req.body.id;
    const order = req.body.order || req.body;
    if(!orderId && !order.orderId) return res.status(400).json({error:'Order ID missing'});
    const payload = buildShiprocketPayload(orderId, order);
    const j = await shiprocketFetch('/orders/create/adhoc', { method:'POST', body:JSON.stringify(payload) });
    res.json({success:true, payload, shiprocket:j});
  }catch(e){res.status(500).json({success:false,error:e.message})}
});

app.listen(process.env.PORT || 3000, ()=>console.log('LFH backend ready'));
