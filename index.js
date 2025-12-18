// index.js

// --- 1. IMPORTAÇÕES ---
const fs = require('fs');
const path = require('path');
const {
    Client,
    GatewayIntentBits,
    Events,
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ChannelType,
    PermissionsBitField,
    ButtonBuilder,
    ButtonStyle,
    REST,
    Routes,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    Partials
} = require('discord.js');
const {
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
} = require('./db.js');


// --- 2. INFORMAÇÕES SECRETAS E CONFIGURAÇÕES ---
// As configurações agora são carregadas das variáveis de ambiente
require('dotenv').config(); // Carrega variáveis do arquivo .env para desenvolvimento local

// Discord
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID;
const GUILD_ID = process.env.GUILD_ID;
const OWNER_ID = process.env.OWNER_ID;
const SITE_URL = process.env.SITE_URL; // Esta será a URL do Render

// Pagamento
const PIX_KEY = process.env.PIX_KEY;

// Moderação - A lista agora é carregada do banco de dados
let profanitySet = new Set();

// --- 3. INICIALIZAÇÃO DOS CLIENTES ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel] // Necessário para receber DMs
});

// --- 4. "BANCO DE DADOS" E FUNÇÕES AUXILIARES ---

/**
 * Registra um evento de auditoria no console e em um arquivo de log.
 * @param {string} message A mensagem a ser registrada.
 */
async function logAuditEvent(message) {
    const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    console.log(`[AUDITORIA] ${message}`);
    // Agora salva no banco de dados em vez de um arquivo.
    await addAuditLog(message);
}

/**
 * Cria e retorna o painel de compras com o menu de seleção de produtos.
 * @param {object} productStock O objeto de estoque carregado.
 * @returns {{embeds: EmbedBuilder[], components: ActionRowBuilder[]} | {content: string, ephemeral: boolean}}
 */
function createShoppingPanel(productStock) {
    const embed = new EmbedBuilder()
        .setTitle('🛒 Central de Compras')
        .setDescription('Bem-vindo à nossa loja! Por favor, selecione o produto que você deseja comprar no menu abaixo.')
        .setColor('Blue')
        .setFooter({ text: 'Seu ticket de compra será criado após a seleção.' });

    const inStockProducts = Object.entries(productStock).filter(([, product]) => product.stock === -1 || product.stock > 0);

    if (inStockProducts.length === 0) {
        embed.setDescription('nao sobrou nada pro beta');
        embed.setColor('Red');
        return { embeds: [embed], components: [] };
    }

    const productOptions = inStockProducts.map(([productId, product]) => {
        const stockInfo = product.stock === -1 ? 'Ilimitado' : `${product.stock} em estoque`;
        return {
            label: product.name,
            description: `R$ ${product.price} | Estoque: ${stockInfo}`,
            value: productId,
            emoji: product.emoji || undefined
        };
    });

    inStockProducts.forEach(([productId, product]) => {
        const stockInfo = product.stock === -1 ? 'Ilimitado' : product.stock;
        embed.addFields({
            name: `${product.emoji || '📦'} ${product.name} - R$ ${product.price}`,
            value: `*${product.description}*\n**Estoque:** ${stockInfo}\n**ID:** \`${productId}\``,
            inline: false
        });
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select-product')
        .setPlaceholder('Clique aqui para escolher um produto')
        .addOptions(productOptions);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    return { embeds: [embed], components: [row] };
}

/**
 * Tenta atualizar o painel de compras fixo, se existir.
 */
async function updateFixedShoppingPanel() {
    const panelConfig = await getConfig('fixed_panel');
    if (panelConfig.panelMessageId && panelConfig.panelChannelId) {
        try {
            const channel = await client.channels.fetch(panelConfig.panelChannelId);
            if (channel && channel.isTextBased()) {
                const message = await channel.messages.fetch(panelConfig.panelMessageId);
                const productStock = await getProducts();
                const updatedPanel = createShoppingPanel(productStock);
                await message.edit(updatedPanel);
                await logAuditEvent(`Painel de compras fixo atualizado no canal ${channel.name}.`);
            }
        } catch (error) {
            if (error.code === 10008 || error.code === 10003) { // Unknown Message or Unknown Channel
                console.log(`Painel de compras antigo não encontrado (mensagem ou canal deletado). Limpando configuração.`);
                await setConfig('fixed_panel', { panelMessageId: null, panelChannelId: null }); // Limpa a configuração se a mensagem/canal não existe mais
            } else {
                console.error('Erro ao tentar atualizar o painel de compras fixo:', error);
            }
        }
    }
}

/**
 * Processa a confirmação de um pagamento, deleta o canal de pagamento e cria o de entrega.
 * @param {import('discord.js').Guild} guild O servidor onde a ação ocorre.
 * @param {string} channelId O ID do canal de pagamento.
 * @param {string} productId O ID do produto comprado.
 * @param {import('discord.js').User} adminUser O administrador que confirmou o pagamento.
 */
async function processPaymentConfirmation(guild, channelId, productId, adminUser) {
    const paymentChannel = await guild.channels.fetch(channelId).catch(() => null);
    if (!paymentChannel || !paymentChannel.topic) {
        console.error(`[ERRO] Canal de pagamento ${channelId} não encontrado ou sem tópico.`);
        return { success: false, message: 'Canal de pagamento não encontrado.' };
    }

    const userIdMatch = paymentChannel.topic.match(/User: (\d+)/);
    if (!userIdMatch) {
        console.error(`[ERRO] Não foi possível extrair o ID do usuário do tópico do canal ${channelId}.`);
        return { success: false, message: 'ID do usuário não encontrado no canal.' };
    }
    const userId = userIdMatch[1];
    const user = await client.users.fetch(userId);

    const product = await getProductById(productId);

    if (product && product.stock !== -1) { // -1 é estoque infinito
        await decreaseProductStock(productId);
    }

    await logAuditEvent(`PAGAMENTO CONFIRMADO: Admin ${adminUser.tag} confirmou o pagamento para ${user.tag} (Produto: ${product?.name || 'desconhecido'}, ID: ${productId}).`);
    await paymentChannel.delete('Pagamento confirmado. Criando canal de entrega.');
    await updateFixedShoppingPanel();

    const deliveryChannel = await guild.channels.create({
        name: `entrega-${user.username.slice(0, 20)}`,
        type: ChannelType.GuildText,
        topic: `Canal de entrega para ${user.tag} (ID: ${user.id}) | Produto: ${productId}`,
        permissionOverwrites: [
            { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
            { id: ADMIN_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel] },
        ],
    });

    const embed = new EmbedBuilder().setTitle('📦 Entrega Pronta').setDescription(`O pagamento de ${user} para o produto **${product?.name || 'desconhecido'}** foi confirmado!`).setColor('Green').addFields({ name: 'Ação Necessária', value: `Realize a entrega do produto para o usuário <@${user.id}> neste canal.` });
    await deliveryChannel.send({ content: `Atenção, <@&${ADMIN_ROLE_ID}>!`, embeds: [embed] });

    // Envia o link de entrega para o admin
    await sendDeliveryNotification({
        context: { type: 'ticket', channelId: deliveryChannel.id, userId: user.id, productId: productId, productName: product?.name || 'Desconhecido' }
    });

    return { success: true, message: `Pagamento aprovado para ${user.tag}. Canal de entrega criado.` };
}

/**
 * Processa a ação de aprovar ou recusar vinda do site.
 * @param {string} action 'approve' ou 'reject'
 * @param {object} context Os dados do pedido/ticket
 * @returns {{success: boolean, message: string}}
 */
async function processVerificationAction(action, context) {
    const { type, orderId, channelId, userId, productId, productName } = context;
    const guild = await client.guilds.fetch(GUILD_ID);

    if (action === 'approve') {
        if (type === 'ticket') {
            const result = await processPaymentConfirmation(guild, channelId, productId, await client.users.fetch(OWNER_ID));
            return result;
        } else if (type === 'site') {
            const targetOrder = await getOrderById(orderId, userId);
            await updateOrderStatus(orderId, 'approved');
            const channelName = `chat-${targetOrder.productName.slice(0, 10)}-${userId.slice(-4)}`;
            const ticketChannel = await guild.channels.create({
                name: channelName, type: ChannelType.GuildText, topic: `Chat do Pedido do Site | OrderID: ${orderId} | UserID: ${userId}`,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                    { id: ADMIN_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel] },
                ],
            });
            await updateOrderStatus(orderId, 'approved', { ticketChannelId: ticketChannel.id });

            // Envia o link de entrega para o admin
            await sendDeliveryNotification({
                context: { type: 'site', orderId: orderId, userId: userId, productName: targetOrder.productName }
            });

            await logAuditEvent(`SITE: Pedido ${orderId} de <@${userId}> APROVADO via link.`);
            await ticketChannel.send({ content: `Olá <@${userId}> e <@&${ADMIN_ROLE_ID}>! Este é o chat para o seu pedido **${targetOrder.productName}**.` });
            return { success: true, message: `Pedido do site ${orderId} APROVADO. Canal de chat #${channelName} criado.` };
        }
    } else if (action === 'reject') {
        if (type === 'ticket') {
            const paymentChannel = await guild.channels.fetch(channelId).catch(() => null);
            if (paymentChannel) {
                await paymentChannel.send('❌ O seu comprovante foi analisado e **recusado**. Por favor, envie um comprovante válido ou entre em contato com o suporte.');
            }
            await logAuditEvent(`PAGAMENTO RECUSADO: Comprovante no canal ${paymentChannel?.name || channelId} recusado via link.`);
            return { success: true, message: `Pagamento RECUSADO para o canal ${paymentChannel?.name || 'desconhecido'}. O usuário foi notificado.` };
        } else if (type === 'site') {
            await updateOrderStatus(orderId, 'declined');
            await logAuditEvent(`SITE: Pedido ${orderId} de <@${userId}> RECUSADO via link.`);
            return { success: true, message: `Pedido do site ${orderId} RECUSADO. O usuário será notificado no site.` };
        }
    } else if (action === 'deliver') {
        if (type === 'ticket') {
            const deliveryChannel = await guild.channels.fetch(channelId).catch(() => null);
            if (deliveryChannel) {
                await deliveryChannel.send('✅ Entrega confirmada! Este canal será excluído em 10 segundos.');
                setTimeout(() => deliveryChannel.delete('Entrega concluída.'), 10000);
            }
            const user = await client.users.fetch(userId);
            await user.send(`🎉 Sua compra do produto **${productName}** foi concluída com sucesso! Obrigado por comprar conosco.`).catch(console.error);
            await logAuditEvent(`ENTREGA CONFIRMADA (via Link): Entrega para ${user.tag} (Produto: ${productName}) concluída.`);
            return { success: true, message: `Entrega para o ticket ${deliveryChannel?.name || 'desconhecido'} confirmada.` };
        } else if (type === 'site') {
            const targetOrder = await getOrderById(orderId, userId);
            if (!targetOrder) return { success: false, message: `Pedido do site com ID ${orderId} não encontrado.` };
            await updateOrderStatus(orderId, 'entregue');
            const systemMessage = { author: 'system', content: 'O pedido foi marcado como ENTREGUE pela administração e este chat foi finalizado.', timestamp: new Date().toISOString() };
            await addMessageToOrder(orderId, systemMessage);

            const user = await client.users.fetch(userId).catch(() => null);
            if (user) {
                await user.send(`🎉 Sua compra do pedido **${targetOrder.productName}** (\`${orderId}\`) foi concluída e entregue com sucesso!`).catch(console.error);
            }

            const { io } = require('./server.js');
            io.to(orderId).emit('new_message_from_server', systemMessage);
            await logAuditEvent(`SITE: Pedido ${orderId} de ${user?.tag || userId} marcado como ENTREGUE via link.`);
            const ticketChannel = await guild.channels.fetch(targetOrder.ticketChannelId).catch(() => null);
            if (ticketChannel) setTimeout(() => ticketChannel.delete('Pedido do site entregue.'), 10000);
            return { success: true, message: `Pedido do site ${orderId} marcado como ENTREGUE.` };
        }
    }
    return { success: false, message: 'Ação desconhecida.' };
}

// --- 5. EVENTOS DO DISCORD ---

// Evento disparado quando o bot fica online
client.on(Events.ClientReady, async () => {
    console.log(`✅ Bot pronto e online como ${client.user.tag}`);
    await logAuditEvent(`Bot iniciado e online como ${client.user.tag}.`);

    // --- REGISTRO DOS COMANDOS DE BARRA ---
    // ... (código de registro de comandos permanece o mesmo)
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        console.log('Iniciando o registro dos comandos de barra.');

        await rest.put(
            Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID),
            {
                body: [
                    {
                        name: 'comprar',
                        description: 'Abre um menu para selecionar e comprar um produto.',
                    },
                    {
                        name: 'painel',
                        description: 'Cria um painel de compras fixo neste canal (Apenas ADM).',
                        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
                    },
                    {
                        name: 'edit',
                        description: 'Edita um item existente no estoque (Apenas ADM).',
                        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
                        options: [{ name: 'id', type: 3, description: 'O ID do produto a ser editado', required: true }],
                    },
                    {
                        name: 'delete',
                        description: 'Deleta um item do estoque (Apenas ADM).',
                        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
                        options: [{ name: 'id', type: 3, description: 'O ID do produto a ser deletado', required: true }],
                    },
                    {
                        name: 'termos',
                        description: 'Exibe os termos de serviço e a política de reembolso da loja (Apenas ADM).',
                        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
                    },
                    {
                        name: 'verificar',
                        description: 'Vincula sua conta do Discord ao site da Jyl Store.',
                        options: [{ name: 'codigo', type: 3, description: 'O código de verificação fornecido pelo site', required: true }],
                    },
                    {
                        name: 'profanidade',
                        description: 'Gerencia a lista de palavras proibidas (Apenas ADM).',
                        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
                        options: [
                            {
                                name: 'adicionar',
                                description: 'Adiciona uma palavra ao filtro.',
                                type: 1, // 1 = SUB_COMMAND
                                options: [{ name: 'palavra', type: 3, description: 'A palavra a ser adicionada', required: true }]
                            },
                            {
                                name: 'remover',
                                description: 'Remove uma palavra do filtro.',
                                type: 1, // 1 = SUB_COMMAND
                                options: [{ name: 'palavra', type: 3, description: 'A palavra a ser removida', required: true }]
                            },
                            { name: 'listar', description: 'Lista todas as palavras no filtro.', type: 1 }
                        ]
                    }
                ],
            },
        );

        console.log('Comandos de barra registrados com sucesso!');
    } catch (error) {
        console.error('Erro ao registrar comandos de barra:', error);
    }

    // Carrega a lista de profanidade do banco de dados para a memória
    const words = await getProfanityWords();
    profanitySet = new Set(words);
});

// Evento principal para todas as interações
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) { // Lida com comandos de barra
        const { commandName } = interaction;
        const productStock = await getProducts();

        if (commandName === 'comprar') {
            const panel = createShoppingPanel(productStock);
            await interaction.reply({ ...panel, ephemeral: true });
        } else if (commandName === 'painel') {
            const panel = createShoppingPanel(productStock);
            const reply = await interaction.reply({ ...panel, ephemeral: false, fetchReply: true });

            // Salva as informações do painel fixo
            const panelConfig = { panelMessageId: reply.id, panelChannelId: reply.channel.id };
            await setConfig('fixed_panel', panelConfig);
            await logAuditEvent(`Painel de compras fixo definido no canal #${reply.channel.name} (ID: ${reply.channel.id})`);
        } else if (commandName === 'delete') {
            const productId = interaction.options.getString('id');
            const product = await getProductById(productId);
            if (!product) {
                return interaction.reply({ content: `❌ Nenhum produto encontrado com o ID \`${productId}\`.`, ephemeral: true });
            }
            const confirmButton = new ButtonBuilder().setCustomId(`confirm-delete_${productId}`).setLabel('Sim, deletar').setStyle(ButtonStyle.Danger);
            const cancelButton = new ButtonBuilder().setCustomId('cancel-delete').setLabel('Cancelar').setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);
            await interaction.reply({
                content: `Você tem certeza que deseja deletar o item **${productStock[productId].name}** (ID: \`${productId}\`)? Esta ação não pode ser desfeita.`,
                components: [row],
                ephemeral: true,
            });
        } else if (commandName === 'edit') {
            const productId = interaction.options.getString('id');
            const product = await getProductById(productId);
            if (!product) {
                return interaction.reply({ content: `❌ Nenhum produto encontrado com o ID \`${productId}\`.`, ephemeral: true });
            }
            const modal = new ModalBuilder().setCustomId(`edit-modal_${productId}`).setTitle(`Editando: ${product.name}`);
            const nameInput = new TextInputBuilder().setCustomId('name').setLabel("Novo nome do produto").setStyle(TextInputStyle.Short).setValue(product.name).setRequired(true);
            const priceInput = new TextInputBuilder().setCustomId('price').setLabel("Novo preço (ex: 19.99)").setStyle(TextInputStyle.Short).setValue(product.price).setRequired(true);
            const descriptionInput = new TextInputBuilder().setCustomId('description').setLabel("Nova descrição").setStyle(TextInputStyle.Paragraph).setValue(product.description).setRequired(false);
            const emojiInput = new TextInputBuilder().setCustomId('emoji').setLabel("Novo emoji (opcional)").setStyle(TextInputStyle.Short).setValue(product.emoji || '').setRequired(false);
            const stockInput = new TextInputBuilder().setCustomId('stock').setLabel("Estoque (-1 para infinito)").setStyle(TextInputStyle.Short).setValue(String(product.stock)).setRequired(true);

            // CORREÇÃO: Adiciona cada input em sua própria ActionRow.
            modal.addComponents(
                new ActionRowBuilder().addComponents(nameInput),
                new ActionRowBuilder().addComponents(priceInput),
                new ActionRowBuilder().addComponents(descriptionInput),
                new ActionRowBuilder().addComponents(emojiInput),
                new ActionRowBuilder().addComponents(stockInput)
            );
            await interaction.showModal(modal);
        } else if (commandName === 'termos') {
            const termsEmbed = new EmbedBuilder()
                .setColor('Navy')
                .setTitle('📜 Termos de Serviço e Política de Reembolso - Jyl Store')
                .setDescription('Ao realizar uma compra em nossa loja, você concorda com os seguintes termos e condições. Leia atentamente antes de prosseguir.')
                .addFields(
                    {
                        name: '1. Termos de Venda',
                        value: 'Ao efetuar uma compra na Jyl Store, você concorda que todas as transações serão processadas exclusivamente através do nosso sistema de tickets no Discord. O pagamento é realizado via chave Pix, e a confirmação da compra depende do envio de um comprovante válido pelo comprador e da verificação manual por um de nossos administradores. É de sua responsabilidade garantir que o item selecionado para compra é o desejado, pois, uma vez confirmada a transação e iniciada a entrega, a venda é considerada final e vinculativa. Qualquer tentativa de fraude ou má-fé resultará no cancelamento da compra e possível banimento de nossos serviços.'
                    },
                    {
                        name: '2. Política de Reembolso',
                        value: '**A Jyl Store NÃO OFERECE REEMBOLSO** para produtos digitais após a entrega ter sido efetivada e confirmada. Consideramos a entrega como concluída no momento em que o produto é disponibilizado no canal de entrega dedicado e o acesso é concedido ao comprador. A partir desse ponto, a venda é considerada definitiva e irrevogável. A única circunstância em que um reembolso poderá ser considerado é em caso de falha comprovada e irrefutável por parte da Jyl Store em entregar o produto adquirido, ou se o produto entregue for substancialmente diferente do descrito no momento da compra. Reclamações de reembolso baseadas em arrependimento, incompatibilidade de software (não informada previamente) ou mau uso do produto não serão aceitas.'
                    },
                    {
                        name: '3. Uso e Responsabilidade',
                        value: 'Uma vez que o produto digital é entregue e o acesso é concedido, a total responsabilidade pelo seu uso, segurança, armazenamento e gerenciamento recai sobre o comprador. A Jyl Store não se responsabiliza por quaisquer problemas decorrentes de mau uso, negligência, perda de dados, acesso não autorizado por terceiros ou qualquer outra questão que surja após a entrega bem-sucedida do produto. É estritamente proibido revender, redistribuir, compartilhar, alugar ou transferir os produtos adquiridos da Jyl Store a terceiros sem consentimento expresso. O uso indevido ou a violação destes termos pode resultar na revogação do acesso ao produto e em medidas adicionais, sem direito a reembolso.'
                    },
                    {
                        name: '4. Suporte ao Cliente',
                        value: 'A Jyl Store se compromete a oferecer suporte para questões diretamente relacionadas à *entrega* do produto adquirido, garantindo que você receba o que comprou. No entanto, é importante ressaltar que **não fornecemos suporte técnico** para a instalação, configuração, personalização ou uso do produto em seu ambiente específico (ex: compatibilidade com outros softwares, problemas de hardware, etc.). Para qualquer dúvida ou problema relacionado à entrega, por favor, entre em contato com um de nossos administradores através do canal de suporte ou DM. Nosso objetivo é garantir que sua experiência de compra seja a mais tranquila possível.'
                    }
                )
                .setFooter({ text: 'Jyl Store | Agradecemos a sua preferência!' });

            await interaction.reply({ embeds: [termsEmbed] });
        } else if (commandName === 'verificar') {
            const { verificationMap } = require('./server.js'); // Importa o mapa do server
            const code = interaction.options.getString('codigo');

            if (verificationMap.has(code)) {
                const discordUser = interaction.user;

                // Salva a associação
                await findOrCreateAccount({
                    id: discordUser.id,
                    username: discordUser.username,
                    discriminator: discordUser.discriminator,
                    avatar: discordUser.avatarURL()
                });

                await logAuditEvent(`LOGIN SITE: Usuário ${discordUser.tag} (ID: ${discordUser.id}) verificou sua conta no site.`);
                await interaction.reply({ content: '✅ Sua conta foi verificada com sucesso! Você já pode fechar a página de verificação no seu navegador.', ephemeral: true });
            } else {
                await interaction.reply({ content: '❌ Código de verificação inválido ou expirado. Por favor, tente fazer o login no site novamente.', ephemeral: true });
            }
        } else if (commandName === 'profanidade') {
            const subCommand = interaction.options.getSubcommand();
            const palavra = interaction.options.getString('palavra')?.toLowerCase();

            if (subCommand === 'adicionar') {
                const added = await addProfanityWord(palavra);
                if (added) {
                    profanitySet.add(palavra);
                    await logAuditEvent(`MODERAÇÃO: ${interaction.user.tag} adicionou a palavra "${palavra}" ao filtro de profanidade.`);
                    await interaction.reply({ content: `✅ A palavra \`${palavra}\` foi adicionada ao filtro.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `⚠️ A palavra \`${palavra}\` já está no filtro.`, ephemeral: true });
                }
            } else if (subCommand === 'remover') {
                const removed = await removeProfanityWord(palavra);
                if (removed) {
                    profanitySet.delete(palavra);
                    await logAuditEvent(`MODERAÇÃO: ${interaction.user.tag} removeu a palavra "${palavra}" do filtro de profanidade.`);
                    await interaction.reply({ content: `✅ A palavra \`${palavra}\` foi removida do filtro.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `⚠️ A palavra \`${palavra}\` não foi encontrada no filtro.`, ephemeral: true });
                }
            } else if (subCommand === 'listar') {
                const wordList = [...profanitySet].join(', ');
                const embed = new EmbedBuilder().setTitle('🚫 Lista de Palavras Proibidas').setDescription(wordList.length > 0 ? `\`\`\`${wordList}\`\`\`` : 'O filtro está vazio.').setColor('Orange');
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        }
    } else if (interaction.isStringSelectMenu()) { // Lida com a seleção do produto
        if (interaction.customId !== 'select-product') return;

        const productId = interaction.values[0];
        const product = await getProductById(productId);
        const user = interaction.user;

        if (!product) {
            return interaction.update({ content: '❌ Este produto não foi encontrado. Pode ter sido removido.', embeds: [], components: [] });
        }

        if (product.stock !== -1 && product.stock <= 0) {
            return interaction.update({ content: '❌ Desculpe, este produto está fora de estoque!', embeds: [], components: [] });
        }

        await interaction.deferUpdate();
        await interaction.followUp({ content: `✅ Você selecionou: **${product.name}**. Seu canal de pagamento privado está sendo criado...`, ephemeral: true });

        try {
            // Cria um "número de ticket" único para o canal
            const ticketId = `pagamento-${user.username.slice(0, 10)}-${Date.now().toString().slice(-4)}`;

            const paymentChannel = await interaction.guild.channels.create({
                name: ticketId,
                type: ChannelType.GuildText,
                topic: `Ticket: ${ticketId} | User: ${user.id} | ProductID: ${productId}`,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                    { id: ADMIN_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel] }, // Permite que ADMs vejam o canal
                ],
            });

            const paymentEmbed = new EmbedBuilder()
                .setTitle(`🛒 Detalhes do Pagamento`)
                .setDescription(`Olá ${user}! Para concluir a compra do item **${product.name}**, realize o pagamento e envie o comprovante aqui.`)
                .addFields(
                    { name: 'Produto', value: product.name, inline: true },
                    { name: 'Valor a Pagar', value: `**R$ ${product.price}**`, inline: true },
                    { name: 'Chave Pix (Copia e Cola)', value: `\`\`\`${PIX_KEY}\`\`\`` }
                )
                .setColor('Gold')
                .setFooter({ text: `ID do Ticket: ${ticketId}` });

            const confirmButton = new ButtonBuilder()
                .setCustomId(`confirm-payment_${productId}`)
                .setLabel('Confirmar Pagamento (ADM)')
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder().addComponents(confirmButton);

            // Envia o embed e os botões
            await paymentChannel.send({ content: `Atenção <@&${ADMIN_ROLE_ID}>, novo pedido!`, embeds: [paymentEmbed], components: [row] });
            // Envia a chave PIX em uma mensagem separada para facilitar o "copia e cola"
            await paymentChannel.send(`${PIX_KEY}`);

        } catch (error) {
            console.error('Erro ao criar canal de pagamento:', error);
            await interaction.followUp({ content: '❌ Ocorreu um erro crítico ao criar seu canal. Tente novamente.', ephemeral: true });
        }
    } else if (interaction.isButton()) {
        const [action, id] = interaction.customId.split('_');

        if (action === 'confirm-delete') {
            const product = await getProductById(id);
            const productName = product?.name || 'desconhecido'; // Define productName antes de usar
            if (product) {
                await deleteProduct(id);
                await logAuditEvent(`ADMIN: ${interaction.user.tag} (ID: ${interaction.user.id}) deletou o produto "${productName}" (ID: ${id}).`);
                await interaction.update({ content: `✅ O produto **${productName}** foi deletado com sucesso.`, components: [] });
                await updateFixedShoppingPanel(); // Atualiza o painel fixo
            } else {
                await interaction.update({ content: '❌ O produto não foi encontrado (talvez já tenha sido deletado).', components: [] });
            }
        } else if (action === 'cancel-delete') {
            await interaction.update({ content: 'Operação cancelada.', components: [] });
        } else if (action === 'confirm-payment') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: '❌ Você não tem permissão para confirmar pagamentos.', ephemeral: true });
            }

            // A interação é respondida implicitamente pela exclusão do canal.
            // Não é necessário deferUpdate() ou reply() aqui, pois o canal onde o botão está será deletado.
            await processPaymentConfirmation(interaction.guild, interaction.channel.id, id, interaction.user);

        }
    } else if (interaction.isModalSubmit()) { // Lida com o envio do formulário de edição
        const [action, productId] = interaction.customId.split('_');

        if (action === 'edit-modal') {
            const newName = interaction.fields.getTextInputValue('name');
            const newPrice = parseFloat(interaction.fields.getTextInputValue('price'));
            const newDescription = interaction.fields.getTextInputValue('description');
            const newEmoji = interaction.fields.getTextInputValue('emoji');
            const newStock = parseInt(interaction.fields.getTextInputValue('stock'), 10);

            if (isNaN(newPrice) || newPrice <= 0 || isNaN(newStock)) {
                return interaction.reply({ content: '⚠️ O preço ou o estoque informado não são números válidos.', ephemeral: true });
            }

            await updateProduct(productId, {
                name: newName,
                price: newPrice.toFixed(2),
                description: newDescription || `Produto editado por ${interaction.user.tag}`,
                emoji: newEmoji || '📦',
                stock: newStock
            });

            await logAuditEvent(`ADMIN: ${interaction.user.tag} (ID: ${interaction.user.id}) editou o produto ID ${productId}. Novo nome: "${newName}", Novo preço: R$ ${newPrice.toFixed(2)}, Novo estoque: ${newStock}.`);
            await interaction.reply({ content: `✅ O produto **${newName}** (ID: \`${productId}\`) foi atualizado com sucesso!`, ephemeral: true });
            await updateFixedShoppingPanel(); // Atualiza o painel fixo
        }
    }
});

/**
 * Envia uma notificação de comprovante para o dono do bot com botões de ação.
 * @param {object} verificationData
 * @param {object} verificationData.details Detalhes para exibição na página.
 * @param {object} verificationData.context Dados para processar a ação.
 */
async function sendProofForVerification(verificationData) {
    try {
        const { verificationTokens } = require('./server.js');
        const crypto = require('crypto');

        const verificationId = crypto.randomBytes(16).toString('hex');

        verificationTokens.set(verificationId, {
            ...verificationData
        });

        // O token expira em 1 hora para segurança
        setTimeout(() => verificationTokens.delete(verificationId), 3600000);

        const verificationUrl = `${SITE_URL}/verify/${verificationId}`;

        const owner = await client.users.fetch(OWNER_ID);
        const embed = new EmbedBuilder()
            .setTitle('🔎 Nova Verificação de Comprovante (Clique aqui)')
            .setURL(verificationUrl) // Define a URL do título, tornando-o clicável
            .setDescription(`Um novo comprovante foi enviado e precisa da sua atenção.\n\n**Clique aqui para verificar**`)
            .setColor('Orange') // A cor estava correta, apenas para referência
            .setTimestamp();

        await owner.send({ embeds: [embed] });
        await logAuditEvent(`VERIFICAÇÃO: Notificação de comprovante enviada para o dono do bot.`);
    } catch (e) {
        console.error("Erro ao enviar DM de verificação para o dono do bot:", e);
    }
}

/**
 * Envia uma notificação de entrega para o dono do bot com um link de ação.
 * @param {object} deliveryData
 * @param {object} deliveryData.context Dados para processar a ação.
 */
async function sendDeliveryNotification(deliveryData) {
    try {
        const { verificationTokens } = require('./server.js');
        const crypto = require('crypto');

        const verificationId = crypto.randomBytes(16).toString('hex');

        // Adiciona a ação 'deliver' ao token
        const tokenPayload = {
            action: 'deliver',
            context: deliveryData.context,
            details: { productName: deliveryData.context.productName } // Estrutura os detalhes
        };

        verificationTokens.set(verificationId, tokenPayload);

        setTimeout(() => verificationTokens.delete(verificationId), 3600000); // Expira em 1 hora

        const deliveryUrl = `${SITE_URL}/verify/${verificationId}`;

        const owner = await client.users.fetch(OWNER_ID);
        const embed = new EmbedBuilder()
            .setTitle('📦 Marcar Pedido como Entregue (Clique aqui)')
            .setURL(deliveryUrl)
            .setDescription(`Um pedido foi aprovado e está pronto para ser marcado como entregue.\n\n**Produto:** ${deliveryData.context.productName}`)
            .setColor('Green').setTimestamp();

        await owner.send({ embeds: [embed] });
        await logAuditEvent(`ENTREGA: Notificação para marcar como entregue enviada ao admin.`);
    } catch (e) { console.error("Erro ao enviar DM de notificação de entrega:", e); }
}
// Evento para o comando !addstock
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // --- FILTRO DE PROFANIDADE ---
    // Normaliza a mensagem removendo espaços e caracteres que podem ser usados para burlar o filtro.
    const normalizedMessage = message.content.toLowerCase().replace(/[\s\.\-\_]/g, '');

    // --- PONTE DE CHAT (DISCORD -> SITE) ---
    if (message.channel.topic && message.channel.topic.startsWith('Chat do Pedido do Site')) {
        // Ignora mensagens do próprio bot para evitar loops
        if (message.author.bot) return;

        const topic = message.channel.topic;
        const orderIdMatch = topic.match(/OrderID: (\S+)/);
        const userIdMatch = topic.match(/UserID: (\d+)/);

        if (orderIdMatch) {
            const orderId = orderIdMatch[1];
                const newMessage = {
                    author: 'staff', // Mensagens do Discord são sempre de 'staff'
                    content: message.content,
                    timestamp: new Date().toISOString()
                };
            await addMessageToOrder(orderId, newMessage);

                // Emite a mensagem para o chat do site via Socket.IO
                const { io } = require('./server.js');
                io.to(orderId).emit('new_message_from_server', newMessage);
        }
    }

    const hasProfanity = [...profanitySet].some(word => normalizedMessage.includes(word));

    if (hasProfanity) {
        // Não mutar administradores
        if (message.member && message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return;
        }

        try {
            // 1. Envia a DM para o usuário
            await message.author.send('bobao vou limpar sua boca com agua e sabao');

            // 2. Silencia o membro por 1 dia (24 horas)
            if (message.member && message.member.moderatable) {
                await message.member.timeout(24 * 60 * 60 * 1000, 'Uso de linguagem imprópria.');
                await logAuditEvent(`MODERAÇÃO: Usuário ${message.author.tag} (ID: ${message.author.id}) foi silenciado por 24h por uso de linguagem imprópria na mensagem: "${message.content}"`);
            } else {
                await logAuditEvent(`MODERAÇÃO: Não foi possível silenciar ${message.author.tag} (permissões insuficientes ou membro não moderável).`);
            }

            // 3. Deleta a mensagem ofensiva
            await message.delete();
        } catch (error) {
            console.error('Erro ao tentar moderar usuário por profanidade:', error);
        }
    }

    // Detecta envio de comprovante em canais de pagamento
    if (message.channel.name.startsWith('pagamento-') && message.attachments.size > 0) {
        const topic = message.channel.topic;
        if (!topic) return;

        const userIdMatch = topic.match(/User: (\d+)/);
        const productIdMatch = topic.match(/ProductID: (\S+)/);
        if (!userIdMatch || !productIdMatch) return;

        const userId = userIdMatch[1]; // O ID do usuário que está comprando
        const productId = productIdMatch[1];
        const product = await getProductById(productId);

        await message.reply(`✅ Comprovante recebido! Nossa equipe administrativa irá analisá-lo em breve.`).catch(console.error);

        // Usa a nova função unificada para enviar a DM de verificação
        await sendProofForVerification({
            details: {
                title: 'Verificação de Ticket',
                userTag: message.author.tag,
                productName: product?.name || 'Desconhecido',
                productPrice: product?.price || 'N/A',
                imageUrl: message.attachments.first().url
            },
            context: {
                type: 'ticket',
                channelId: message.channel.id,
                userId: userId,
                productId: productId
            }
        });
        return;
    }

    // Se a mensagem não for um comando, interrompe aqui.
    if (!message.content.startsWith('!')) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // --- COMANDOS DE TEXTO PARA ADMINS ---
    if (message.author.id === OWNER_ID || message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
    }

    if (command === 'addstock') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply('❌ Você não tem permissão para usar este comando.');
        }

        // Formato: !addstock [nome do item] | [preço] | [estoque] | [emoji]
        const parts = args.join(' ').split('|').map(p => p.trim());
        const [name, priceStr, stockStr, emoji] = parts;

        const price = parseFloat(priceStr);
        const stock = parseInt(stockStr, 10);

        if (parts.length < 3 || !name || isNaN(price) || price <= 0 || isNaN(stock)) {
            return message.reply('⚠️ **Uso incorreto!** O formato é: `!addstock [nome] | [preço] | [estoque] | [emoji opcional]`\nExemplo: `!addstock Chave Misteriosa | 15.50 | 50 | 🔑`');
        }

        const productId = `${name.substring(0, 2).toUpperCase()}${Date.now().toString().slice(-5)}`;
        await addProduct({
            id: productId,
            name: name,
            price: price.toFixed(2),
            description: `Produto adicionado por ${message.author.tag}`,
            emoji: emoji || '📦',
            stock: stock
        });
        await logAuditEvent(`ADMIN: ${message.author.tag} (ID: ${message.author.id}) adicionou o produto "${name}" (ID: ${productId}) com estoque ${stock} e preço R$ ${price.toFixed(2)}.`);
        await message.reply(`✅ Produto **${name}** adicionado ao estoque com o ID \`${productId}\` e preço R$ ${price.toFixed(2)}.`);
        await updateFixedShoppingPanel(); // Atualiza o painel fixo
    }
});

// --- 7. INICIALIZAÇÃO ---
function loginBot() {
    return client.login(DISCORD_TOKEN);
}

// Exporta o cliente e a função de login para serem usados pelo server.js
module.exports = {
    client,
    loginBot,
    GUILD_ID,
    DISCORD_CLIENT_ID,
    DISCORD_TOKEN,
    DISCORD_CLIENT_SECRET,
    OWNER_ID,
    SITE_URL, // <- Adicionado para uso no server.js
    ADMIN_ROLE_ID,
    sendProofForVerification, // <- Exporta a nova função
    processVerificationAction // <- Exporta a função de processamento
    // A nova função sendDeliveryNotification não precisa ser exportada, pois é chamada internamente.
};
