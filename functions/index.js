const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// 1. ПОЛУЧЕНИЕ ДИНАМИЧЕСКИХ ТАРИФОВ ИЗ FIRESTORE
exports.getPricing = functions.https.onRequest(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const pricingDoc = await db.collection('settings').doc('pricing').get();
        if (!pricingDoc.exists) {
            return res.status(404).json({ error: 'Документ pricing не найден в Firestore (settings/pricing)' });
        }
        return res.status(200).json(pricingDoc.data());
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 2. СОЗДАНИЕ СЕССИИ ОПЛАТЫ НА ОСНОВЕ FIRESTORE
exports.createPayment = functions.https.onRequest(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const { email, metadata } = req.body;
        const { tierId, daysToAdd, newDeviceLimit } = metadata;

        // Читаем тарифы и цены из Firestore (settings/pricing)
        const pricingDoc = await db.collection('settings').doc('pricing').get();
        if (!pricingDoc.exists) {
            return res.status(500).json({ error: 'Тарифная сетка не найдена в Firestore' });
        }
        const pricing = pricingDoc.data();

        const selectedTier = pricing.TIERS[tierId];
        if (!selectedTier) return res.status(400).json({ error: 'Тариф не найден' });

        const selectedPlan = selectedTier.plans.find(p => p.days === daysToAdd);
        if (!selectedPlan) return res.status(400).json({ error: 'Выбранный период не найден' });

        const extraDevicePrice = pricing.EXTRA_DEVICE_PRICE || 10;
        const months = Math.max(1, Math.round(daysToAdd / 30));
        const extraDevices = Math.max(0, newDeviceLimit - 3);

        const finalPrice = selectedPlan.price + (extraDevices * extraDevicePrice * months);
        const amountStr = Number(finalPrice).toFixed(2);
        const currency = 'RUB';

        const order_id = Date.now().toString() + Math.floor(Math.random() * 90 + 10).toString();
        const safeDesc = `Оплата заказа ${order_id}`;

        // Читаем настройки AnyPay из Firestore (settings/anypay)
        const anypayDoc = await db.collection('settings').doc('anypay').get();
        if (!anypayDoc.exists) {
            return res.status(500).json({ error: 'Настройки AnyPay не найдены в Firestore (settings/anypay)' });
        }
        const anypayConfig = anypayDoc.data();
        const merchant_id = String(anypayConfig.merchant_id).trim();
        const secret_key = String(anypayConfig.secret_key).trim();
        const white_site_url = anypayConfig.white_site_url || "https://gridport.ru";

        // Сохраняем заказ в Firestore
        await db.collection('orders').doc(order_id).set({
            email: email.toLowerCase(),
            tierId: tierId,
            daysToAdd: daysToAdd,
            newDeviceLimit: newDeviceLimit,
            amount: finalPrice,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Создаем временного пользователя в Firestore, если его еще нет
        const userDoc = await db.collection('users').doc(email.toLowerCase()).get();
        if (!userDoc.exists) {
            await db.collection('users').doc(email.toLowerCase()).set({
                email: email.toLowerCase(),
                vpn_uuid: crypto.randomUUID(),
                sub_id: crypto.randomUUID(),
                panel_login: `web_${email.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')}`,
                inviteCode: crypto.createHash('md5').update(email.toLowerCase()).digest('hex').substring(0, 16).toUpperCase(),
                tier: tierId,
                last_login: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // MD5 Подпись: currency:amount:secret_key:merchant_id:pay_id
        const signArray = [currency, amountStr, secret_key, merchant_id, order_id];
        const signature = crypto.createHash('md5').update(signArray.join(':')).digest('hex');

        const params = new URLSearchParams({
            merchant_id: merchant_id,
            pay_id: order_id,
            amount: amountStr,
            currency: currency,
            desc: safeDesc,
            email: email,
            sign: signature
        });

        const anypayUrl = `https://anypay.io/merchant?${params.toString()}`;
        const cleanWhiteSiteUrl = white_site_url.replace(/\/$/, "");
        const finalRedirectUrl = `${cleanWhiteSiteUrl}/pay.html?link=${encodeURIComponent(anypayUrl)}`;

        return res.status(200).json({ url: finalRedirectUrl });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});

// 3. ВЕБХУК ОПОВЕЩЕНИЯ ОБ ОПЛАТЕ ОТ ANYPAY
exports.anypayWebhook = functions.https.onRequest(async (req, res) => {
    const body = req.method === 'POST' ? req.body : req.query;
    const { merchant_id, amount, pay_id, currency, status, sign } = body;

    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
    const allowedIps = ['185.162.128.38', '185.162.128.39', '185.162.128.88'];
    if (!allowedIps.includes(clientIp)) {
        return res.status(403).send('bad ip!');
    }

    try {
        const anypayDoc = await db.collection('settings').doc('anypay').get();
        if (!anypayDoc.exists) return res.status(500).send('Config missing in Firestore');
        const { secret_key, merchant_id: project_id } = anypayDoc.data();

        // Проверка подписи: merchant_id:amount:pay_id:secret_key
        const signArray = [project_id, amount, pay_id, secret_key];
        const expectedSign = crypto.createHash('md5').update(signArray.join(':')).digest('hex');

        if (sign !== expectedSign) {
            return res.status(400).send('wrong sign!');
        }

        if (status !== 'paid') {
            return res.status(200).send('OK');
        }

        const orderRef = db.collection('orders').doc(pay_id);
        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) return res.status(200).send('OK');

        const order = orderDoc.data();
        if (order.status === 'paid') return res.status(200).send('OK');

        await orderRef.update({
            status: 'paid',
            paidAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Создаем / продлеваем пользователя в БД
        const userEmail = order.email;
        const userRef = db.collection('users').doc(userEmail);
        const userDoc = await userRef.get();

        const msToAdd = order.daysToAdd * 86400000;
        let finalExpiryTime = Date.now() + msToAdd;

        if (userDoc.exists) {
            const userData = userDoc.data();
            const curExpiry = userData.subscription_expiry || 0;
            if (curExpiry > Date.now()) {
                finalExpiryTime = curExpiry + msToAdd;
            }
        }

        await userRef.set({
            email: userEmail,
            vpn_uuid: userDoc.exists ? (userDoc.data().vpn_uuid || crypto.randomUUID()) : crypto.randomUUID(),
            sub_id: userDoc.exists ? (userDoc.data().sub_id || crypto.randomUUID()) : crypto.randomUUID(),
            tier: order.tierId,
            subscription_expiry: finalExpiryTime,
            device_limit: order.newDeviceLimit,
            last_purchase: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.status(200).send('OK');
    } catch (err) {
        console.error(err);
        return res.status(500).send('Server Error');
    }
});
