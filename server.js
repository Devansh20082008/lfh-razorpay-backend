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

const VELOCITY_BASE = 'https://shazam.velocity.in';
let velocityToken = null;
let velocityTokenExpiry = 0;

const NIMBUSPOST_BASE = (process.env.NIMBUSPOST_BASE_URL || 'https://api.nimbuspost.com').replace(/\/$/,'');
let nimbusToken = null;
let nimbusTokenTime = 0;


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

async function velocityLogin(){
  const username = process.env.VELOCITY_USERNAME;
  const password = process.env.VELOCITY_PASSWORD;
  if(!username || !password) throw new Error('Velocity credentials missing in Render Environment');
  if(velocityToken && Date.now() < velocityTokenExpiry) return velocityToken;
  const r = await fetch(VELOCITY_BASE + '/custom/api/v1/auth-token', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username, password})
  });
  const text = await r.text();
  let j; try{ j = text ? JSON.parse(text) : {}; }catch(e){ j = { raw:text }; }
  if(!r.ok || !j.token) throw new Error(j.message || j.error || JSON.stringify(j).slice(0,300) || 'Velocity login failed');
  velocityToken = j.token;
  // Velocity token is valid 24 hours; refresh after 23 hours.
  velocityTokenExpiry = Date.now() + 23*60*60*1000;
  return velocityToken;
}

async function velocityFetch(path, options={}){
  const token = await velocityLogin();
  const r = await fetch(VELOCITY_BASE + path, {
    ...options,
    headers:{
      'Content-Type':'application/json',
      'Authorization': token,
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let j; try{ j = text ? JSON.parse(text) : {}; }catch(e){ j = { raw:text }; }
  if(!r.ok) throw new Error(j.message || j.error || JSON.stringify(j).slice(0,300) || 'Velocity API error');
  return j;
}

function velocityEnvReady(){
  return !!(process.env.VELOCITY_USERNAME && process.env.VELOCITY_PASSWORD && process.env.VELOCITY_WAREHOUSE_ID);
}

function velocityZoneRate(zone){
  const key = String(zone || '').toLowerCase();
  const defaults = {zone_a:64, zone_b:78, zone_c:95, zone_d:115, zone_e:135};
  const envName = 'VELOCITY_' + key.toUpperCase() + '_RATE';
  return n(process.env[envName], defaults[key] || n(process.env.VELOCITY_DEFAULT_RATE, 64));
}

async function velocityServiceabilityRate({pickup, delivery, cod=true}){
  const body = {from:String(pickup), to:String(delivery), payment_mode:cod?'cod':'prepaid', shipment_type:'forward'};
  const j = await velocityFetch('/custom/api/v1/serviceability', {method:'POST', body:JSON.stringify(body)});
  const carriers = j?.result?.serviceability_results || [];
  const zone = j?.result?.zone || '';
  const rate = velocityZoneRate(zone);
  return {
    success:true,
    provider:'Velocity',
    pickup_pincode:String(pickup),
    delivery_pincode:String(delivery),
    best: carriers[0] ? {courier_company_id:carriers[0].carrier_id, courier_name:carriers[0].carrier_name, carrier_id:carriers[0].carrier_id, rate, zone} : {courier_name:'Velocity Shipping', rate, zone},
    couriers: carriers.slice(0,8).map(c=>({courier_company_id:c.carrier_id, carrier_id:c.carrier_id, courier_name:c.carrier_name, rate, zone})),
    raw:j,
    note:'Velocity docs serviceability returns carriers/zone. Rate is estimated from zone unless Velocity provides a dedicated rate API.'
  };
}

function buildVelocityPayload(orderId, order){
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
    tax: 0
  }));
  const vendor = {
    email: process.env.VELOCITY_VENDOR_EMAIL || process.env.VELOCITY_EMAIL || 'thedevansh09@gmail.com',
    phone: cleanPhone(process.env.VELOCITY_VENDOR_PHONE || process.env.SHOP_PHONE || '') || '7049461974',
    name: process.env.VELOCITY_VENDOR_NAME || 'Lovely Fashion House',
    address: process.env.VELOCITY_VENDOR_ADDRESS || 'Bazaar Chowk Sabha Manch ke piche Ward No 08 Lamta',
    address_2: '',
    city: process.env.VELOCITY_VENDOR_CITY || 'Lamta',
    state: process.env.VELOCITY_VENDOR_STATE || 'Madhya Pradesh',
    country: 'India',
    pin_code: process.env.VELOCITY_PICKUP_PINCODE || '481551',
    pickup_location: process.env.VELOCITY_PICKUP_LOCATION || 'Lovely Fashion House'
  };
  return {
    order_id: safeText(order.orderId || orderId),
    order_date: todayDate().slice(0,16),
    carrier_id: order.velocityCarrierId || order.carrier_id || '',
    billing_customer_name: safeText(c.name, 'Customer'),
    billing_last_name: '',
    billing_address: address.slice(0,190),
    billing_city: city,
    billing_pincode: pincode,
    billing_state: state,
    billing_country: 'India',
    billing_email: safeText(c.email, 'customer@example.com'),
    billing_phone: phone,
    shipping_is_billing: true,
    print_label: true,
    order_items: orderItems,
    payment_method: codAmount > 0 ? 'COD' : 'PREPAID',
    sub_total: n(order.total,0) || n(order.subtotal,0) || codAmount || 1,
    cod_collectible: codAmount,
    length: n(order.length, 10) || 10,
    breadth: n(order.breadth, 10) || 10,
    height: n(order.height, 4) || 4,
    weight: totalWeight,
    pickup_location: process.env.VELOCITY_PICKUP_LOCATION || 'Lovely Fashion House',
    warehouse_id: process.env.VELOCITY_WAREHOUSE_ID,
    vendor_details: vendor
  };
}

function nimbusEnvReady(){
  return !!(
    (process.env.NIMBUSPOST_API_KEY || process.env.NIMBUSPOST_API_EMAIL || process.env.NIMBUSPOST_EMAIL || process.env.NIMBUSPOST_USERNAME) &&
    (process.env.NIMBUSPOST_API_SECRET || process.env.NIMBUSPOST_SECRET_KEY || process.env.NIMBUSPOST_SECRET || process.env.NIMBUSPOST_PASSWORD)
  );
}
function nimbusEmail(){ return process.env.NIMBUSPOST_API_EMAIL || process.env.NIMBUSPOST_EMAIL || process.env.NIMBUSPOST_USERNAME || process.env.NIMBUSPOST_API_KEY || ''; }
function nimbusSecret(){ return process.env.NIMBUSPOST_API_SECRET || process.env.NIMBUSPOST_SECRET_KEY || process.env.NIMBUSPOST_SECRET || process.env.NIMBUSPOST_PASSWORD || ''; }
async function nimbusLogin(){
  if(!nimbusEnvReady()) throw new Error('NimbusPost API email/key or secret missing in Render Environment');
  if(nimbusToken && (Date.now()-nimbusTokenTime) < 6*60*60*1000) return nimbusToken;
  const email = nimbusEmail();
  const secret = nimbusSecret();
  const candidates = [
    {path:'/v1/users/login', body:{email, password:secret}},
    {path:'/v1/user/login', body:{email, password:secret}},
    {path:'/v1/auth/login', body:{email, password:secret}},
    {path:'/v1/login', body:{email, password:secret}},
    {path:'/v1/oauth/token', body:{email, password:secret}},
    {path:'/v1/auth-token', body:{email, password:secret}},
    {path:'/v1/users/login', body:{api_key:process.env.NIMBUSPOST_API_KEY||email, secret_key:secret}},
    {path:'/v1/login', body:{api_key:process.env.NIMBUSPOST_API_KEY||email, secret_key:secret}}
  ];
  let last = '';
  for(const c of candidates){
    try{
      const r = await fetch(NIMBUSPOST_BASE + c.path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(c.body)});
      const text = await r.text();
      let j; try{ j = text ? JSON.parse(text) : {}; }catch(e){ j = {raw:text}; }
      const token = j.token || j.access_token || j.data?.token || j.data?.access_token || j.result?.token || j.payload?.token;
      if(r.ok && token){ nimbusToken = token; nimbusTokenTime = Date.now(); console.log('NimbusPost login success via', c.path); return nimbusToken; }
      last = `${c.path}: HTTP ${r.status} ${JSON.stringify(j).slice(0,250)}`;
    }catch(e){ last = `${c.path}: ${e.message}`; }
  }
  throw new Error('NimbusPost login failed. Last response: ' + last);
}
async function nimbusFetch(path, options={}){
  const token = await nimbusLogin();
  const r = await fetch(NIMBUSPOST_BASE + path, {
    ...options,
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token, ...(options.headers||{})}
  });
  const text = await r.text();
  let j; try{ j = text ? JSON.parse(text) : {}; }catch(e){ j = {raw:text}; }
  if(!r.ok) throw new Error(j.message || j.error || JSON.stringify(j).slice(0,300) || 'NimbusPost API error');
  return j;
}
function mapNimbusRateResponse(j){
  const arr = j?.data?.available_courier_companies || j?.data?.courier_companies || j?.data?.couriers || j?.couriers || j?.available_courier_companies || j?.result || [];
  const list = Array.isArray(arr) ? arr : (Array.isArray(j?.data) ? j.data : []);
  const mapped = list.map(c=>({
    courier_company_id: c.courier_company_id || c.courier_id || c.id || c.carrier_id || c.code || '',
    courier_name: c.courier_name || c.name || c.carrier_name || c.company_name || 'NimbusPost Courier',
    rate: n(c.rate || c.freight_charge || c.shipping_charges || c.total_charge || c.charge || c.price, 0) + n(c.cod_charges || c.cod_charge, 0),
    freight_charge: n(c.freight_charge || c.shipping_charges || c.rate || c.charge, 0),
    cod_charges: n(c.cod_charges || c.cod_charge, 0),
    etd: c.etd || c.estimated_delivery_days || c.delivery_days || ''
  })).filter(c=>c.rate>0).sort((a,b)=>a.rate-b.rate);
  const rate = n(j?.data?.rate || j?.rate || j?.shipping_charges || j?.data?.shipping_charges, 0);
  if(!mapped.length && rate>0) mapped.push({courier_name:'NimbusPost', rate, freight_charge:rate, cod_charges:0});
  return mapped;
}
async function nimbusPostRate({pickup, delivery, weight=0.5, length=10, breadth=10, height=4, cod=true}){
  const payload = {pickup_postcode:String(pickup), delivery_postcode:String(delivery), cod:cod?1:0, weight:n(weight,0.5), length:n(length,10), breadth:n(breadth,10), height:n(height,4)};
  const query = new URLSearchParams(payload).toString();
  const attempts = [
    {path:'/v1/courier/serviceability?' + query, method:'GET'},
    {path:'/v1/courier/serviceability', method:'POST', body:JSON.stringify(payload)},
    {path:'/v1/rate/calculate', method:'POST', body:JSON.stringify(payload)},
    {path:'/v1/shipments/rate', method:'POST', body:JSON.stringify(payload)}
  ];
  let last='';
  for(const a of attempts){
    try{
      const j = await nimbusFetch(a.path, {method:a.method, body:a.body});
      const mapped = mapNimbusRateResponse(j);
      if(mapped.length){ return {success:true, provider:'NimbusPost', pickup_pincode:String(pickup), delivery_pincode:String(delivery), weight, length, breadth, height, cod:!!cod, best:mapped[0], couriers:mapped.slice(0,8), raw:j}; }
      last = a.path + ': no rate found ' + JSON.stringify(j).slice(0,200);
    }catch(e){ last = a.path + ': ' + e.message; }
  }
  throw new Error('NimbusPost rate failed. ' + last);
}
function buildNimbusPayload(orderId, order){
  const c = order.customer || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const phone = cleanPhone(c.mobile || c.phone);
  const codAmount = Math.max(0, n(order.cod, 0));
  const totalWeight = Math.max(0.1, n(order.totalWeight, items.reduce((s,i)=>s+(n(i.weight,0.5)||0.5)*(n(i.qty,1)||1),0.5)));
  const pincode = safeText(c.pincode || c.pin || c.postcode);
  if(!phone) throw new Error('Customer mobile missing');
  if(!/^\d{6}$/.test(pincode)) throw new Error('Customer pincode missing/invalid');
  if(!items.length) throw new Error('Order items missing');
  const orderItems = items.map((i,idx)=>({name:safeText(i.name,'LFH Product'), sku:safeText(i.id||i.sku||('LFH-SKU-'+(idx+1))), qty:Math.max(1,Math.round(n(i.qty,1))), price:n(i.price,0)||n(order.total,0)||1}));
  return {
    order_id: safeText(order.orderId || orderId),
    order_number: safeText(order.orderId || orderId),
    payment_method: codAmount > 0 ? 'COD' : 'prepaid',
    cod_amount: codAmount,
    amount: n(order.total,0) || n(order.subtotal,0) || codAmount || 1,
    shipping_charges: n(order.delivery,0),
    pickup_postcode: process.env.NIMBUSPOST_PICKUP_PINCODE || process.env.SHIPROCKET_PICKUP_PINCODE || '481551',
    weight: totalWeight,
    length: n(order.length,10)||10,
    breadth: n(order.breadth,10)||10,
    height: n(order.height,4)||4,
    customer_name: safeText(c.name,'Customer'),
    customer_email: safeText(c.email,'customer@example.com'),
    customer_phone: phone,
    customer_address: safeText(c.address,'Lovely Fashion House Customer Address'),
    customer_city: safeText(c.city,'Lamta'),
    customer_state: safeText(c.state,'Madhya Pradesh'),
    customer_pincode: pincode,
    products: orderItems,
    order_items: orderItems,
    consignee: {name:safeText(c.name,'Customer'), mobile:phone, email:safeText(c.email,'customer@example.com'), address:safeText(c.address,'Lovely Fashion House Customer Address'), city:safeText(c.city,'Lamta'), state:safeText(c.state,'Madhya Pradesh'), pincode}
  };
}
async function nimbusCreateOrder(orderId, order){
  const payload = buildNimbusPayload(orderId, order);
  const attempts = [
    {path:'/v1/shipments', body:payload},
    {path:'/v1/shipments/create', body:payload},
    {path:'/v1/orders', body:payload},
    {path:'/v1/orders/create', body:payload},
    {path:'/v1/shipments/create', body:{shipments:[payload]}}
  ];
  let last='';
  for(const a of attempts){
    try{
      const j = await nimbusFetch(a.path, {method:'POST', body:JSON.stringify(a.body)});
      return {success:true, payload, nimbuspost:j, usedEndpoint:a.path};
    }catch(e){ last = a.path + ': ' + e.message; }
  }
  throw new Error('NimbusPost order create failed. ' + last);
}


app.get('/', (req,res)=>res.send('LFH Razorpay + NimbusPost backend running'));

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

// Shipping rate/serviceability check. Velocity preferred when env vars are present; Shiprocket remains fallback.
app.post('/shipping-rate', async (req,res)=>{
  try{
    const pickup = String(req.body.pickup_pincode || process.env.VELOCITY_PICKUP_PINCODE || process.env.SHIPROCKET_PICKUP_PINCODE || '481551');
    const delivery = String(req.body.delivery_pincode || req.body.pincode || '').trim();
    const weight = Math.max(0.1, n(req.body.weight, 0.5));
    const length = Math.max(1, n(req.body.length, 10));
    const breadth = Math.max(1, n(req.body.breadth, 10));
    const height = Math.max(1, n(req.body.height, 4));
    const cod = req.body.cod === false ? 0 : 1;
    if(!/^\d{6}$/.test(delivery)) return res.status(400).json({error:'Valid delivery pincode missing'});

    if(nimbusEnvReady()){
      const nr = await nimbusPostRate({pickup, delivery, weight, length, breadth, height, cod:!!cod});
      return res.json(nr);
    }

    if(velocityEnvReady()){
      const vr = await velocityServiceabilityRate({pickup, delivery, cod:!!cod});
      vr.weight = weight; vr.length = length; vr.breadth = breadth; vr.height = height; vr.cod = !!cod;
      return res.json(vr);
    }

    const qs = new URLSearchParams({ pickup_postcode:pickup, delivery_postcode:delivery, cod:String(cod), weight:String(weight), length:String(length), breadth:String(breadth), height:String(height) });
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
    res.json({success:true, provider:'Shiprocket', pickup_pincode:pickup, delivery_pincode:delivery, weight, length, breadth, height, cod:!!cod, best:mapped[0]||null, couriers:mapped.slice(0,8), raw:j});
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


// Admin button se Velocity me order create hoga. Customer payment ke baad automatic nahi.
app.post('/velocity/create-order', async (req,res)=>{
  try{
    const orderId = req.body.orderId || req.body.id;
    const order = req.body.order || req.body;
    if(!orderId && !order.orderId) return res.status(400).json({error:'Order ID missing'});
    if(!velocityEnvReady()) return res.status(400).json({error:'Velocity credentials/warehouse missing in Render Environment'});
    const payload = buildVelocityPayload(orderId, order);
    const j = await velocityFetch('/custom/api/v1/forward-order-orchestration', { method:'POST', body:JSON.stringify(payload) });
    res.json({success:true, payload, velocity:j});
  }catch(e){res.status(500).json({success:false,error:e.message})}
});


// Admin button se NimbusPost me order create hoga. Customer payment ke baad automatic nahi.
app.post('/nimbuspost/create-order', async (req,res)=>{
  try{
    const orderId = req.body.orderId || req.body.id;
    const order = req.body.order || req.body;
    if(!orderId && !order.orderId) return res.status(400).json({error:'Order ID missing'});
    if(!nimbusEnvReady()) return res.status(400).json({error:'NimbusPost API key/secret missing in Render Environment'});
    const result = await nimbusCreateOrder(orderId, order);
    res.json(result);
  }catch(e){res.status(500).json({success:false,error:e.message})}
});

app.listen(process.env.PORT || 3000, ()=>console.log('LFH backend ready'));

