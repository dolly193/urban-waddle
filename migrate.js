// migrate.js
const fs = require('fs').promises;
const path = require('path');
const { pool, createTables } = require('./db.js');

const STOCK_FILE_PATH = path.join(__dirname, 'data', 'stock.json');
const ACCOUNTS_FILE_PATH = path.join(__dirname, 'data', 'data_accounts.json');

async function migrateProducts() {
    try {
        const stockData = JSON.parse(await fs.readFile(STOCK_FILE_PATH, 'utf8'));
        const client = await pool.connect();

        console.log('Iniciando migração de produtos...');
        for (const productId in stockData) {
            const product = stockData[productId];
            const query = `
                INSERT INTO products (id, name, price, description, emoji, stock)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    price = EXCLUDED.price,
                    description = EXCLUDED.description,
                    emoji = EXCLUDED.emoji,
                    stock = EXCLUDED.stock;
            `;
            const values = [productId, product.name, product.price, product.description, product.emoji, product.stock];
            await client.query(query, values);
            console.log(`Produto '${product.name}' (ID: ${productId}) migrado.`);
        }
        client.release();
        console.log('✅ Migração de produtos concluída!');
    } catch (error) {
        console.error('❌ Erro ao migrar produtos:', error);
    }
}

async function migrateAccountsAndOrders() {
    try {
        const accountsData = JSON.parse(await fs.readFile(ACCOUNTS_FILE_PATH, 'utf8'));
        const client = await pool.connect();

        console.log('Iniciando migração de contas e pedidos...');
        for (const accountId in accountsData) {
            const account = accountsData[accountId];
            
            // Migra a conta
            const accountQuery = `
                INSERT INTO accounts (id, username, discriminator, avatar, "verifiedAt")
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (id) DO NOTHING;
            `;
            const accountValues = [accountId, account.username, account.discriminator, account.avatar, account.verifiedAt];
            await client.query(accountQuery, accountValues);
            console.log(`Conta '${account.username}' (ID: ${accountId}) migrada.`);

            // Migra os pedidos da conta
            if (account.orders && account.orders.length > 0) {
                for (const order of account.orders) {
                    const orderQuery = `
                        INSERT INTO orders (id, "userId", "productId", "productName", status, "createdAt", "receiptUrl", "ticketChannelId", messages)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        ON CONFLICT (id) DO NOTHING;
                    `;
                    const orderValues = [
                        order.id,
                        order.userId,
                        order.productId,
                        order.productName,
                        order.status,
                        order.createdAt,
                        order.receiptUrl,
                        order.ticketChannelId,
                        order.messages ? JSON.stringify(order.messages) : null
                    ];
                    await client.query(orderQuery, orderValues);
                    console.log(`-- Pedido '${order.id}' migrado.`);
                }
            }
        }
        client.release();
        console.log('✅ Migração de contas e pedidos concluída!');
    } catch (error) {
        console.error('❌ Erro ao migrar contas e pedidos:', error);
    }
}

async function runMigration() {
    await createTables(); // Garante que as tabelas sejam criadas antes da migração
    await migrateProducts();
    await migrateAccountsAndOrders();
    await pool.end(); // Fecha a conexão com o banco de dados
}

runMigration();