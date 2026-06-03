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
  // NimbusPost NEW API docs ke hisaab se login email + password chahiye.
  return !!(
    (process.env.NIMBUSPOST_EMAIL || process.env.NIMBUSPOST_API_EMAIL || process.env.NIMBUSPOST_USERNAME) &&
    (process.env.NIMBUSPOST_PASSWORD || process.env.NIMBUSPOST_API_PASSWORD || process.env.NIMBUSPOST_API_SECRET || process.env.NIMBUSPOST_SECRET_KEY || process.env.NIMBUSPOST_SECRET)
  );
}
function nimbusEmail(){
  return process.env.NIMBUSPOST_EMAIL || process.env.NIMBUSPOST_API_EMAIL || process.env.NIMBUSPOST_USERNAME || '';
}
function nimbusPassword(){
  return process.env.NIMBUSPOST_PASSWORD || process.env.NIMBUSPOST_API_PASSWORD || process.env.NIMBUSPOST_API_SECRET || process.env.NIMBUSPOST_SECRET_KEY || process.env.NIMBUSPOST_SECRET || '';
}
function extractNimbusToken(j){
  // NimbusPost NEW API login response normally aisa hota hai:
  // { "status": true, "data": "<JWT_TOKEN>" }
  if(typeof j?.data === 'string') return j.data;
  if(typeof j?.token === 'string') return j.token;
  if(typeof j?.access_token === 'string') return j.access_token;
  return j?.data?.token || j?.data?.access_token || j?.data?.auth_token || j?.result?.token || j?.payload?.token;
}
async function nimbusLogin(){
  if(!nimbusEnvReady()) throw new Error('NimbusPost NEW API email/password missing. Render me NIMBUSPOST_EMAIL aur NIMBUSPOST_PASSWORD add karo.');
  if(nimbusToken && (Date.now()-nimbusTokenTime) < 6*60*60*1000) return nimbusToken;
  const email = nimbusEmail();
  const password = nimbusPassword();

  // NimbusPost NEW Partners API docs: POST https://api.nimbuspost.com/v1/users/login
  const r = await fetch(NIMBUSPOST_BASE + '/v1/users/login', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ email, password })
  });
  const text = await r.text();
  let j; try{ j = text ? JSON.parse(text) : {}; }catch(e){ j = {raw:text}; }
  const token = extractNimbusToken(j);
  if(!r.ok || !token){
    throw new Error('/v1/users/login failed: HTTP '+r.status+' '+JSON.stringify(j).slice(0,300));
  }
  nimbusToken = token;
  nimbusTokenTime = Date.now();
  console.log('NimbusPost login success via /v1/users/login');
  return nimbusToken;
}
async function nimbusFetch(path, options={}){
  const token = await nimbusLogin();
  const r = await fetch(NIMBUSPOST_BASE + path, {
    ...options,
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token, ...(options.headers||{})}
  });
  const text = await r.text();
  let j; try{ j = text ? JSON.parse(text) : {}; }catch(e){ j = {raw:text}; }
  if(!r.ok || j.status === false){
    throw new Error((j.message || j.error || JSON.stringify(j).slice(0,300) || 'NimbusPost API error') + ' [HTTP '+r.status+']');
  }
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
  // NimbusPost NEW docs me separate live-rate endpoint clear nahi hai. Isliye fallback chal sakta hai.
  // Agar NimbusPost rate endpoint active hua to ye common endpoints try karega.
  const payload = {
    pickup_postcode:String(pickup),
    delivery_postcode:String(delivery),
    payment_type: cod ? 'cod' : 'prepaid',
    cod: cod?1:0,
    package_weight: Math.round(n(weight,0.5)*1000),
    package_length:n(length,10),
    package_breadth:n(breadth,10),
    package_height:n(height,4)
  };
  const attempts = [
    {path:'/v1/courier/serviceability', method:'POST', body:JSON.stringify(payload)},
    {path:'/v1/shipments/serviceability', method:'POST', body:JSON.stringify(payload)},
    {path:'/v1/rates', method:'POST', body:JSON.stringify(payload)},
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

  const productLines = items.map((i,idx)=>({
    name:safeText(i.name,'LFH Product'),
    sku:safeText(i.id||i.sku||('LFH-SKU-'+(idx+1))).slice(0,50),
    qty:Math.max(1,Math.round(n(i.qty,1))),
    price:n(i.price,0)||n(order.subtotal,0)||1
  }));

  // NimbusPost NEW docs: POST /v1/shipments. order total automatically calculate nahi hota.
  return {
    order_number: safeText(order.orderId || orderId).slice(0,20),
    shipping_charges: n(order.delivery,0),
    discount: 0,
    cod_charges: codAmount > 0 ? n(order.delivery,0) : 0,
    payment_type: codAmount > 0 ? 'cod' : 'prepaid',
    order_amount: n(order.total,0) || n(order.subtotal,0) || codAmount || 1,
    package_weight: Math.round(totalWeight * 1000), // grams
    package_length: n(order.length,10)||10,
    package_breadth: n(order.breadth,10)||10,
    package_height: n(order.height,4)||4,
    request_auto_pickup: 'yes',
    consignee: {
      name: safeText(c.name,'Customer'),
      address: safeText(c.address,'Lovely Fashion House Customer Address'),
      address_2: safeText(c.address2||''),
      city: safeText(c.city,'Lamta'),
      state: safeText(c.state,'Madhya Pradesh'),
      pincode,
      phone,
      email: safeText(c.email,'customer@example.com')
    },
    pickup: {
      warehouse_name: process.env.NIMBUSPOST_PICKUP_LOCATION || 'Lovely Fashion House',
      name: 'Lovely Fashion House',
      address: process.env.NIMBUSPOST_PICKUP_ADDRESS || 'Bazaar Chowk Sabha Manch ke piche Ward No 08 Lamta',
      city: process.env.NIMBUSPOST_PICKUP_CITY || 'Lamta',
      state: process.env.NIMBUSPOST_PICKUP_STATE || 'Madhya Pradesh',
      pincode: process.env.NIMBUSPOST_PICKUP_PINCODE || '481551',
      phone: process.env.NIMBUSPOST_PICKUP_PHONE || '7049461974',
      email: process.env.NIMBUSPOST_EMAIL || process.env.NIMBUSPOST_API_EMAIL || 'thedevansh09@gmail.com'
    },
    // NimbusPost validation me item qty required aata hai, isliye common aliases bhi bhej rahe hain.
    item_name: productLines[0]?.name || 'LFH Product',
    item_sku: productLines[0]?.sku || 'LFH-SKU-1',
    item_qty: productLines[0]?.qty || 1,
    item_price: productLines[0]?.price || 1,
    products: productLines.map(x=>({
      name:x.name, sku:x.sku, qty:x.qty, quantity:x.qty, item_qty:x.qty, price:x.price, selling_price:x.price, item_price:x.price
    })),
    items: productLines.map(x=>({
      name:x.name, sku:x.sku, qty:x.qty, quantity:x.qty, item_qty:x.qty, price:x.price, selling_price:x.price, item_price:x.price
    })),
    order_items: productLines.map(x=>({
      name:x.name, sku:x.sku, units:x.qty, qty:x.qty, quantity:x.qty, item_qty:x.qty, selling_price:x.price, price:x.price, item_price:x.price
    }))
  };
}
function extractNimbusShipment(j){
  const d = j?.data || j?.payload || j?.result || j || {};
  return {
    order_id: d.order_id || d.orderId || d.id || d.order_number || '',
    shipment_id: d.shipment_id || d.shipmentId || '',
    awb_number: d.awb_number || d.awb || d.awb_code || d.awbNumber || '',
    courier_id: d.courier_id || d.courier_company_id || '',
    courier_name: d.courier_name || d.courier || '',
    label_url: d.label_url || d.label || '',
    raw: j
  };
}
async function nimbusCreateOrder(orderId, order){
  const payload = buildNimbusPayload(orderId, order);
  const j = await nimbusFetch('/v1/shipments', {method:'POST', body:JSON.stringify(payload)});
  return {success:true, payload, nimbuspost:j, shipment:extractNimbusShipment(j), usedEndpoint:'/v1/shipments'};
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

