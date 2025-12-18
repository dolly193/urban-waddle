// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const createTables = async () => {
    const createProductsTable = `
    CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        description TEXT,
        emoji VARCHAR(255),
        stock INTEGER NOT NULL
    );`;

    const createAccountsTable = `
    CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255),
        discriminator VARCHAR(10),
        avatar TEXT,
        "verifiedAt" TIMESTAMPTZ
    );`;

    const createOrdersTable = `
    CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(255) PRIMARY KEY,
        "userId" VARCHAR(255) REFERENCES accounts(id),
        "productId" VARCHAR(255) REFERENCES products(id),
        "productName" VARCHAR(255),
        status VARCHAR(50),
        "createdAt" TIMESTAMPTZ,
        "receiptUrl" TEXT,
        "ticketChannelId" VARCHAR(255),
        messages JSONB
    );`;

    const createAuditLogsTable = `
    CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL,
        "createdAt" TIMESTAMPTZ DEFAULT NOW()
    );`;

    const createAppConfigTable = `
    CREATE TABLE IF NOT EXISTS app_config (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB
    );`;

    const createProfanityWordsTable = `
    CREATE TABLE IF NOT EXISTS profanity_words (
        word VARCHAR(255) PRIMARY KEY
    );`;

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await Promise.all([
                client.query(createProductsTable),
                client.query(createAccountsTable),
                client.query(createOrdersTable),
                client.query(createAuditLogsTable),
                client.query(createAppConfigTable),
                client.query(createProfanityWordsTable),
            ]);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        console.log('Tabelas verificadas/criadas com sucesso no banco de dados.');
    } catch (err) {
        console.error('Erro ao criar tabelas:', err.stack);
    }
};

const getProducts = async () => {
    const { rows } = await pool.query('SELECT * FROM products WHERE stock > 0 OR stock = -1');
    // Converte o array de resultados em um objeto, como era no JSON
    const productsObject = rows.reduce((acc, product) => {
        // Garante que o preço seja um número
        product.price = parseFloat(product.price);
        acc[product.id] = product;
        return acc;
    }, {});
    return productsObject;
};

const getProductById = async (productId) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    if (rows.length > 0) {
        rows[0].price = parseFloat(rows[0].price);
        return rows[0];
    }
    return null;
};

const addProduct = async (product) => {
    const query = `
        INSERT INTO products (id, name, price, description, emoji, stock)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
    `;
    const values = [product.id, product.name, product.price, product.description, product.emoji, product.stock];
    const { rows } = await pool.query(query, values);
    return rows[0];
};

const updateProduct = async (productId, productData) => {
    const query = `
        UPDATE products
        SET name = $1, price = $2, description = $3, emoji = $4, stock = $5
        WHERE id = $6
        RETURNING *;
    `;
    const values = [productData.name, productData.price, productData.description, productData.emoji, productData.stock, productId];
    const { rows } = await pool.query(query, values);
    return rows[0];
};

const deleteProduct = async (productId) => {
    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
};

const decreaseProductStock = async (productId) => {
    const query = `
        UPDATE products
        SET stock = stock - 1
        WHERE id = $1 AND stock > 0;
    `;
    await pool.query(query, [productId]);
};

const findOrCreateAccount = async (discordUser) => {
    const findQuery = 'SELECT * FROM accounts WHERE id = $1';
    let { rows } = await pool.query(findQuery, [discordUser.id]);

    if (rows.length > 0) {
        // Opcional: Atualizar dados se o usuário mudou de nome/avatar
        const updateQuery = 'UPDATE accounts SET username = $1, avatar = $2 WHERE id = $3';
        await pool.query(updateQuery, [discordUser.username, discordUser.avatar, discordUser.id]);
        return rows[0];
    } else {
        const insertQuery = `
            INSERT INTO accounts (id, username, discriminator, avatar, "verifiedAt")
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
        `;
        const values = [discordUser.id, discordUser.username, discordUser.discriminator, discordUser.avatar, new Date()];
        const { rows: newRows } = await pool.query(insertQuery, values);
        return newRows[0];
    }
};

const createOrder = async (orderData) => {
    const query = `
        INSERT INTO orders (id, "userId", "productId", "productName", status, "createdAt", messages)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
    `;
    const values = [
        orderData.id,
        orderData.userId,
        orderData.productId,
        orderData.productName,
        orderData.status,
        orderData.createdAt,
        orderData.messages ? JSON.stringify(orderData.messages) : '[]'
    ];
    const { rows } = await pool.query(query, values);
    return rows[0];
};

const getOrdersByUserId = async (userId) => {
    const { rows } = await pool.query('SELECT * FROM orders WHERE "userId" = $1 ORDER BY "createdAt" DESC', [userId]);
    return rows;
};

const getOrderById = async (orderId, userId) => {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1 AND "userId" = $2', [orderId, userId]);
    return rows.length > 0 ? rows[0] : null;
};

const updateOrderStatus = async (orderId, status, extraData = {}) => {
    const fields = ['status = $2'];
    const values = [orderId, status];
    let paramIndex = 3;

    if (extraData.receiptUrl) {
        fields.push(`"receiptUrl" = $${paramIndex++}`);
        values.push(extraData.receiptUrl);
    }
    if (extraData.ticketChannelId) {
        fields.push(`"ticketChannelId" = $${paramIndex++}`);
        values.push(extraData.ticketChannelId);
    }

    const query = `UPDATE orders SET ${fields.join(', ')} WHERE id = $1 RETURNING *;`;
    const { rows } = await pool.query(query, values);
    return rows[0];
};

const addMessageToOrder = async (orderId, message) => {
    const query = `
        UPDATE orders
        SET messages = messages || $2::jsonb
        WHERE id = $1;
    `;
    await pool.query(query, [orderId, JSON.stringify(message)]);
};

const addAuditLog = async (message) => {
    const query = `INSERT INTO audit_logs (message) VALUES ($1)`;
    try {
        await pool.query(query, [message]);
    } catch (error) {
        console.error('Falha ao inserir log de auditoria no banco de dados:', error);
    }
};

const getConfig = async (key) => {
    const query = 'SELECT value FROM app_config WHERE key = $1';
    const { rows } = await pool.query(query, [key]);
    return rows.length > 0 ? rows[0].value : null;
};

const setConfig = async (key, value) => {
    const query = `
        INSERT INTO app_config (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value;
    `;
    await pool.query(query, [key, JSON.stringify(value)]);
};

const getProfanityWords = async () => {
    const { rows } = await pool.query('SELECT word FROM profanity_words');
    return rows.map(r => r.word);
};

const addProfanityWord = async (word) => {
    const query = 'INSERT INTO profanity_words (word) VALUES ($1) ON CONFLICT (word) DO NOTHING RETURNING *';
    // Salva a palavra em minúsculas para consistência
    const { rows } = await pool.query(query, [word.toLowerCase()]);
    return rows.length > 0; // Retorna true se adicionou, false se já existia
};

const removeProfanityWord = async (word) => {
    const query = 'DELETE FROM profanity_words WHERE word = $1 RETURNING *';
    const { rows } = await pool.query(query, [word.toLowerCase()]);
    return rows.length > 0; // Retorna true se removeu, false se não encontrou
};


module.exports = {
    pool,
    createTables,
    getProducts,
    getProductById,
    addProduct,
    updateProduct,
    deleteProduct,
    decreaseProductStock,
    findOrCreateAccount,
    createOrder,
    getOrdersByUserId,
    getOrderById,
    updateOrderStatus,
    addMessageToOrder,
    addAuditLog,
    getConfig,
    setConfig,
    getProfanityWords,
    addProfanityWord,
    removeProfanityWord,
};