// server.js
const express = require('express');
const session = require('express-session');
const path = require('path');
const http = require('http');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const multer = require('multer'); // Para upload de arquivos
const { Server, Socket } = require('socket.io');
const {
    pool,
    createTables,
    getProducts,
    getProductById,
    findOrCreateAccount,
    createOrder,
    getOrdersByUserId,
    getOrderById,
    updateOrderStatus,
    addMessageToOrder
} = require('./db.js'); // Importa a configuração e a nova função do DB
const cloudinary = require('cloudinary').v2;
// Importa tudo que precisamos do bot, incluindo IDs e o próprio client
const { client, loginBot, GUILD_ID, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, OWNER_ID, ADMIN_ROLE_ID, SITE_URL, sendProofForVerification } = require('./index.js');
const { ChannelType, PermissionsBitField } = require('discord.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Mapa para armazenar tokens de verificação temporários
const verificationTokens = new Map();


// --- CONFIGURAÇÕES ---

// Configura o Cloudinary com as credenciais do ambiente
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configura o Multer para usar a memória, em vez de salvar em disco
const upload = multer({ storage: multer.memoryStorage() });


// --- CONFIGURAÇÃO DO EXPRESS ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET, // Carrega o segredo da sessão do ambiente
    resave: false,
    // Adicionado para lidar com o SameSite cookie policy
    cookie: { sameSite: 'lax' },
    saveUninitialized: true,
}));

// --- ROTAS DO SITE ---

// Rota principal - redireciona para o login se não estiver logado
app.get('/', (req, res) => {
    if (req.session.discordUser) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

// Rota do Dashboard: Mostra os produtos
app.get('/dashboard', async (req, res) => {
    if (!req.session.discordUser) return res.redirect('/login');
    try {
        // Substituímos a leitura do arquivo JSON pela chamada ao banco de dados
        const productsObject = await getProducts();
        // O método Object.values() pega apenas os valores do objeto, que é o que precisamos
        const products = Object.values(productsObject);

        res.render('dashboard', { products, user: req.session.discordUser });
    } catch (error) {
        console.error("Erro ao carregar o dashboard:", error);
        res.status(500).send("Erro ao carregar produtos.");
    }
});

// Rota para o UptimeRobot manter o serviço ativo
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Rota "Meus Pedidos": Mostra o histórico do usuário
app.get('/pedidos', async (req, res) => {
    if (!req.session.discordUser) return res.redirect('/login');
    try {
        // Busca os pedidos do usuário diretamente do banco de dados
        const userOrders = await getOrdersByUserId(req.session.discordUser.id);
        res.render('pedidos', { orders: userOrders, user: req.session.discordUser });
    } catch (error) {
        console.error("Erro ao carregar pedidos:", error);
        res.status(500).send("Erro ao carregar seus pedidos.");
    }
});

// Página de login
app.get('/login', (req, res) => {
    res.render('login', { discord_client_id: DISCORD_CLIENT_ID, site_url: SITE_URL });
});

// Rota de callback do Discord OAuth2
app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).send('Código de autorização não fornecido.');
    }

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: `${SITE_URL}/auth/discord/callback`,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const tokenData = await tokenResponse.json();
        if (tokenData.error) throw new Error(JSON.stringify(tokenData));

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });

        const userData = await userResponse.json();

        // Cria ou encontra a conta do usuário no banco de dados
        await findOrCreateAccount({
            id: userData.id,
            username: userData.username,
            avatar: userData.avatar,
            discriminator: userData.discriminator
        });
        req.session.discordUser = { id: userData.id, username: userData.username, avatar: userData.avatar };
        res.redirect('/dashboard'); // Redireciona para o dashboard após o login bem-sucedido

    } catch (error) {
        console.error('Erro no fluxo de callback do Discord:', error);
        res.status(500).send('Ocorreu um erro interno durante o login.');
    }
});

// Rota para INICIAR um pedido (quando o usuário clica em "Comprar")
app.get('/order/create/:productId', async (req, res) => {
    if (!req.session.discordUser) return res.redirect('/login');
    try {
        const productId = req.params.productId;
        const productData = await getProductById(productId);

        if (!productData) return res.status(404).send("Produto não encontrado.");

        const orderId = `order-site-${Date.now()}`;
        
        const newOrder = {
            id: orderId,
            userId: req.session.discordUser.id,
            productId: product.id,
            productName: product.name,
            status: 'analise', // Aguardando envio do comprovante
            createdAt: new Date().toISOString(),
            messages: [] // Adiciona um array para o histórico de mensagens
        };

        await createOrder(newOrder);

        res.render('awaiting-payment', { product: productData, order: newOrder });

    } catch (error) {
        console.error("Erro ao criar pedido:", error);
        res.status(500).send("Erro ao iniciar o processo de compra.");
    }
});

// Rota para RECEBER o comprovante
app.post('/order/upload/:orderId', upload.single('receipt'), async (req, res) => {
    if (!req.session.discordUser) return res.status(401).send('Não autorizado.');
    if (!req.file) return res.status(400).send('Nenhum arquivo enviado.');

    const { orderId } = req.params;
    const userId = req.session.discordUser.id;

    try {
        const order = await getOrderById(orderId, userId);

        // Faz o upload do buffer do arquivo para o Cloudinary
        const b64 = Buffer.from(req.file.buffer).toString("base64");
        let dataURI = "data:" + req.file.mimetype + ";base64," + b64;
        const cloudinaryResponse = await cloudinary.uploader.upload(dataURI, {
            folder: "comprovantes-bot", // Pasta no Cloudinary para organizar
            public_id: orderId, // Usa o ID do pedido como nome do arquivo
            overwrite: true,
        });

        // Atualiza o status do pedido e salva o caminho do comprovante
        await updateOrderStatus(orderId, 'pending_approval', {
            receiptUrl: cloudinaryResponse.secure_url
        });
        const product = await getProductById(order.productId);

        // Envia a notificação para o admin com a URL da imagem do Cloudinary
        await sendProofForVerification({
            details: {
                title: 'Verificação de Comprovante do Site',
                userTag: req.session.discordUser.username,
                productName: product?.name || 'Desconhecido',
                productPrice: product?.price || 'N/A',
                imageUrl: cloudinaryResponse.secure_url
            },
            context: {
                type: 'site',
                orderId: orderId,
                userId: userId,
                productId: order.productId
            }
        });

        // Redireciona o usuário para a mesma página, mas com um parâmetro que ativa a verificação
        res.redirect(`/order/awaiting-payment/${orderId}?status=pending_approval`);

    } catch (error) {
        console.error("Erro ao processar upload:", error);
        res.status(500).send('Erro ao processar o comprovante.');
    }
});

// Página para aguardar pagamento (precisa de uma rota GET para o redirecionamento)
app.get('/order/awaiting-payment/:orderId', async (req, res) => {
    if (!req.session.discordUser) return res.redirect('/login');
    
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.session.discordUser.id);

    if (!order) return res.status(404).send('Pedido não encontrado.');
    const product = await getProductById(order.productId);

    res.render('awaiting-payment', { product, order });
});

// --- ROTAS DE VERIFICAÇÃO DE COMPROVANTE ---

// Rota para exibir a página de verificação (com ou sem chave)
app.get('/verify/:verificationId', (req, res) => {
    const { verificationId } = req.params;

    const tokenData = verificationTokens.get(verificationId);

    if (!tokenData) {
        return res.status(404).render('action-result', {
            actionResult: { success: false, message: 'Link de verificação inválido ou expirado.' }
        });
    }

    // Decide qual página renderizar com base na ação do token
    if (tokenData.action === 'deliver') {
        res.render('mark-delivery', {
            verificationId,
            details: tokenData.details || {}
        });
    } else { // Ação padrão é verificar comprovante
        res.render('verify-receipt', {
            verificationId,
            details: tokenData.details || {}
        });
    }
});

// Rota para processar a ação (Aprovar/Recusar)
app.post('/verify/action/:verificationId', async (req, res) => {
    const { verificationId } = req.params;
    const { action } = req.body; // 'approve', 'reject', ou 'deliver'

    const tokenData = verificationTokens.get(verificationId);

    if (!tokenData) {
        return res.status(403).render('action-result', { actionResult: { success: false, message: 'Acesso negado. O link pode ter expirado.' } });
    }

    // Importa a função de processamento do index.js
    const { processVerificationAction } = require('./index.js');

    // Se a ação veio do formulário (aprovar/recusar), usa o 'action' do body.
    // Se a ação já está no token (entregar), usa o 'action' do token.
    const finalAction = tokenData.action || action;
    const result = await processVerificationAction(finalAction, tokenData.context);

    // Remove o token após o uso para que não possa ser reutilizado
    verificationTokens.delete(verificationId);

    res.render('action-result', { actionResult: result });
});


// Rota para a página de CHAT do pedido
app.get('/order/chat/:orderId', async (req, res) => {
    if (!req.session.discordUser) return res.redirect('/login');

    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.session.discordUser.id);

    // Apenas permite o acesso se o pedido for do usuário e estiver aprovado ou entregue
    if (!order || (order.status !== 'approved' && order.status !== 'entregue')) {
        return res.status(403).send('Acesso negado. O pedido não foi encontrado ou não está aprovado.');
    }

    res.render('order-chat', { order, user: req.session.discordUser, messages: order.messages || [] });
});


// Rota de API para o frontend verificar o status do pedido
app.get('/order/status/:orderId', async (req, res) => {
    if (!req.session.discordUser) return res.status(401).json({ status: 'unauthorized' });
    try {
        const order = await getOrderById(req.params.orderId, req.session.discordUser.id);
        if (order) {
            res.json({ status: order.status });
        } else {
            res.status(404).json({ status: 'not_found' });
        }
    } catch (error) {
        res.status(500).json({ status: 'error' });
    }
});

// --- LÓGICA DE CHAT EM TEMPO REAL (SOCKET.IO) ---
io.on('connection', (socket) => {
    console.log('🔌 Novo usuário conectado ao chat.');

    socket.on('join_order_room', (orderId) => {
        socket.join(orderId);
        console.log(`Usuário entrou na sala do pedido: ${orderId}`);
    });

    socket.on('chat_message_from_client', async ({ orderId, userId, username, message }) => {
        const order = await getOrderById(orderId, userId);

        const newMessage = {
            author: 'user', // 'user' para o cliente, 'staff' para o admin
            content: message,
            timestamp: new Date().toISOString()
        };

        await addMessageToOrder(orderId, newMessage);

        // Envia a mensagem para todos na sala, EXCETO para o remetente
        socket.to(orderId).emit('new_message_from_server', newMessage);

        // Envia a mensagem para o canal do ticket no Discord
        if (order.ticketChannelId) {
            try {
                const ticketChannel = await client.channels.fetch(order.ticketChannelId);
                await ticketChannel.send(`**[SITE] ${username}:** ${message}`);
            } catch (error) {
                console.error(`Erro ao enviar mensagem do site para o Discord (Canal: ${order.ticketChannelId}):`, error);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Usuário desconectado do chat.');
    });
});

// Inicia o bot do Discord e o servidor web
async function startServer() {
    await createTables(); // Garante que as tabelas do DB existam
    await loginBot(); // Loga o bot primeiro
    server.listen(port, () => {
        console.log(`🚀 Servidor web rodando em http://localhost:${port} e pasta de comprovantes pronta.`);
    });
}

startServer();

// Exporta o 'io' para uso futuro
module.exports = { io, verificationTokens };
