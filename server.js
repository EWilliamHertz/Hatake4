const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const Stripe = require('stripe');
const app = express();

require('dotenv').config();

const db = new sqlite3.Database('hatake.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to SQLite database');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        category TEXT,
        price REAL,
        stock INTEGER,
        release_date TEXT,
        image TEXT,
        description TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        location TEXT,
        isRetailer INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS preorders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        cart TEXT,
        status TEXT,
        created_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS wishlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        product_id INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT,
        region TEXT,
        name TEXT,
        date TEXT,
        location TEXT,
        description TEXT,
        image TEXT,
        link TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        user_id INTEGER,
        rating INTEGER,
        comment TEXT,
        created_at TEXT,
        FOREIGN KEY(product_id) REFERENCES products(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        product_id INTEGER,
        email TEXT,
        type TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )`);
});

function seedDatabase() {
    const products = [
        { name: 'Duffel Bag', category: 'Bag', price: 30.00, stock: 22, release_date: '2025-07-15', image: '/images/xV7ikH1.jpeg', description: '47*28*55cm tournament-ready bag.' },
    ];
    const events = [
        { type: 'convention', region: 'vastra-gotalands-lan', name: 'Need to be Geek Convention – Skara, September 2025', date: 'September 27, 2025', location: 'Multihallen, Skara', description: 'This geek culture event features everything from Pokémon and Star Wars to Warhammer and DnD...', image: 'https://placehold.co/300x200?text=Need+to+be+Geek+Convention', link: 'https://needtobegeek.se' },
    ];
    products.forEach(product => {
        db.run(`INSERT OR IGNORE INTO products (name, category, price, stock, release_date, image, description) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [product.name, product.category, product.price, product.stock, product.release_date, product.image, product.description]);
    });
    events.forEach(event => {
        db.run(`INSERT OR IGNORE INTO events (type, region, name, date, location, description, image, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [event.type, event.region, event.name, event.date, event.location, event.description, event.image, event.link]);
    });
}
seedDatabase();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.get('/', (req, res) => {
    const { category = 'all', sort = 'default', search = '', lang = 'en' } = req.query;
    const translations = {
        en: { welcome: 'Welcome to Hatake', nordicBrand: 'a Nordic TCG Brand', viewProducts: 'View Products' },
        sv: { welcome: 'Välkommen till Hatake', nordicBrand: 'ett nordiskt TCG-varumärke', viewProducts: 'Visa produkter' }
    };
    const t = translations[lang] || translations.en;
    let query = 'SELECT * FROM products';
    let params = [];

    if (search) {
        query += ' WHERE name LIKE ? OR description LIKE ?';
        params.push(`%${search}%`, `%${search}%`);
    }

    if (category !== 'all') {
        query += search ? ' AND' : ' WHERE';
        query += ' category = ?';
        params.push(category);
    }

    if (sort !== 'default') {
        query += ` ORDER BY price ${sort === 'price-low' ? 'ASC' : 'DESC'}`;
    }

    db.all(query, params, async (err, products) => {
        if (err) return res.status(500).send('Database error');
        for (let product of products) {
            const reviews = await new Promise((resolve) => {
                db.all('SELECT rating FROM reviews WHERE product_id = ?', [product.id], (err, reviews) => resolve(reviews));
            });
            product.reviewCount = reviews.length;
            product.averageRating = reviews.length ? reviews.reduce((sum, r) => sum + parseInt(r.rating), 0) / reviews.length : null;
        }
        db.all('SELECT * FROM events', [], (err, events) => {
            if (err) return res.status(500).send('Database error');
            res.render('index', { products, events, category, sort, search, userId: req.session.userId, t });
        });
    });
});

app.get('/checkout', (req, res) => {
    if (!req.session.cart || req.session.cart.length === 0) return res.redirect('/');
    res.render('checkout', { cart: req.session.cart });
});

app.post('/add-to-cart', (req, res) => {
    const { name, price } = req.body;
    if (!req.session.cart) req.session.cart = [];
    const existingItem = req.session.cart.find(item => item.name === name);
    if (existingItem) existingItem.quantity += 1;
    else req.session.cart.push({ name, price: parseFloat(price), quantity: 1 });
    res.json({ success: true, cart: req.session.cart });
});

app.post('/update-cart', (req, res) => {
    const { index, quantity } = req.body;
    req.session.cart[index].quantity = parseInt(quantity);
    res.json({ success: true, cart: req.session.cart });
});

app.post('/remove-from-cart', (req, res) => {
    const { index } = req.body;
    req.session.cart.splice(index, 1);
    res.json({ success: true, cart: req.session.cart });
});

app.post('/preorder', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const cart = req.body.cart;
    const userId = req.session.userId;
    const createdAt = new Date().toISOString();
    db.run('INSERT INTO preorders (user_id, cart, status, created_at) VALUES (?, ?, ?, ?)',
        [userId, cart, 'pending', createdAt], (err) => {
            if (err) return res.status(500).send('Error saving preorder');
            db.run('UPDATE products SET stock = stock - ? WHERE name = ?', [JSON.parse(cart)[0].quantity, JSON.parse(cart)[0].name]);
            res.redirect('/preorder-confirmation');
        });
});

app.get('/preorder-confirmation', (req, res) => {
    res.render('preorder-confirmation', { message: 'Thank you for your preorder! We’ll email you a confirmation soon.' });
});

app.get('/preorder-status', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.all('SELECT * FROM preorders WHERE user_id = ?', [req.session.userId], (err, preorders) => {
        if (err) return res.status(500).send('Database error');
        res.render('preorder-status', { preorders });
    });
});

app.post('/process-payment', async (req, res) => {
    const { paymentIntentId, cart } = req.body;
    try {
        const paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId);
        if (paymentIntent.status === 'succeeded') {
            const userId = req.session.userId || null;
            const createdAt = new Date().toISOString();
            db.run('INSERT INTO preorders (user_id, cart, status, created_at) VALUES (?, ?, ?, ?)',
                [userId, JSON.stringify(cart), 'completed', createdAt]);
            req.session.cart = [];
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'Payment failed' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/payment-confirmation', (req, res) => {
    res.render('payment-confirmation', { message: 'Payment successful! Your order has been placed.' });
});

app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const { name, email, password, location } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (name, email, password, location) VALUES (?, ?, ?, ?)',
        [name, email, hashedPassword, location], function(err) {
            if (err) return res.render('register', { error: 'Email already exists' });
            req.session.userId = this.lastID;
            res.redirect('/');
        });
});

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err || !user) return res.render('login', { error: 'Invalid email or password' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.render('login', { error: 'Invalid email or password' });
        req.session.userId = user.id;
        res.redirect('/');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/profile', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        if (err) return res.status(500).send('Database error');
        db.all('SELECT * FROM preorders WHERE user_id = ?', [req.session.userId], (err, preorders) => {
            if (err) return res.status(500).send('Database error');
            db.all('SELECT w.*, p.name, p.image, p.description, p.price FROM wishlist w JOIN products p ON w.product_id = p.id WHERE w.user_id = ?', [req.session.userId], (err, wishlist) => {
                if (err) return res.status(500).send('Database error');
                res.render('profile', { user, preorders, wishlist });
            });
        });
    });
});

app.post('/profile/update', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { name, email, location } = req.body;
    db.run('UPDATE users SET name = ?, email = ?, location = ? WHERE id = ?',
        [name, email, location, req.session.userId], (err) => {
            if (err) return res.status(500).send('Database error');
            res.redirect('/profile');
        });
});

app.get('/retailer-portal', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        if (err) return res.status(500).send('Database error');
        if (!user.isRetailer) return res.status(403).send('Access denied');
        db.all('SELECT * FROM preorders WHERE user_id = ?', [req.session.userId], (err, orders) => {
            if (err) return res.status(500).send('Database error');
            res.render('retailer-portal', { user, orders });
        });
    });
});

app.post('/partner-application', (req, res) => {
    const { name, email, business_name, location, partnership_type, message, request_samples } = req.body;
    res.render('partner-confirmation', { message: 'Thank you for your application! We’ll get back to you soon.' });
});

app.post('/wishlist/add', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { productId } = req.body;
    db.run('INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)',
        [req.session.userId, productId], (err) => {
            if (err) return res.status(500).send('Database error');
            res.json({ success: true });
        });
});

app.post('/wishlist/remove', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { id } = req.body;
    db.run('DELETE FROM wishlist WHERE id = ? AND user_id = ?',
        [id, req.session.userId], (err) => {
            if (err) return res.status(500).send('Database error');
            res.json({ success: true });
        });
});

app.post('/notify-me', (req, res) => {
    const { productId, email } = req.body;
    const userId = req.session.userId || null;
    db.run('INSERT INTO notifications (user_id, product_id, email, type) VALUES (?, ?, ?, ?)',
        [userId, productId, email, 'back-in-stock'], (err) => {
            if (err) return res.status(500).send('Database error');
            res.json({ success: true, message: 'You will be notified when this product is back in stock!' });
        });
});

app.get('/reviews/:productId', (req, res) => {
    const { productId } = req.params;
    db.all('SELECT r.*, u.name FROM reviews r JOIN users u ON r.user_id = u.id WHERE r.product_id = ?', [productId], (err, reviews) => {
        if (err) return res.status(500).send('Database error');
        res.json(reviews);
    });
});

app.post('/reviews', (req, res) => {
    if (!req.session.userId) return res.status(401).send('Unauthorized');
    const { productId, rating, comment } = req.body;
    const createdAt = new Date().toISOString();
    db.run('INSERT INTO reviews (product_id, user_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?)',
        [productId, req.session.userId, rating, comment, createdAt], (err) => {
            if (err) return res.status(500).send('Database error');
            res.json({ success: true });
        });
});

app.get('/rsvp', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { eventId } = req.query;
    res.json({ success: true, message: 'RSVP confirmed!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));