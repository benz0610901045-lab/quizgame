/**
 * Speed Quiz Payment Worker — Cloudflare Worker
 * Handles Telegram Stars payments via Bot API
 * 
 * SETUP:
 * 1. Create bot via @BotFather → get BOT_TOKEN
 * 2. Deploy this worker to Cloudflare Workers
 * 3. Set environment variables: BOT_TOKEN
 * 4. Set webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/webhook
 */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        
        // CORS headers for Mini App
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            const botToken = env.BOT_TOKEN;
            if (!botToken) {
                return jsonResponse({ error: 'BOT_TOKEN not configured' }, 500, corsHeaders);
            }

            // Route: Create invoice link for Stars payment (donation)
            if (url.pathname === '/create-invoice' && request.method === 'POST') {
                const body = await request.json();
                const { amount, title, description, userId } = body;

                if (!amount || amount < 1) {
                    return jsonResponse({ error: 'Invalid amount' }, 400, corsHeaders);
                }

                const invoiceLink = await createInvoiceLink(botToken, {
                    title: title || '⭐ Поддержка Speed Quiz',
                    description: description || `Донат ${amount} ⭐ Stars автору @shrtrcng`,
                    payload: JSON.stringify({ type: 'donate', amount, userId: userId || 'anonymous', ts: Date.now() }),
                    currency: 'XTR',
                    prices: [{ label: `${amount} Stars`, amount: parseInt(amount) }],
                });

                // Log transaction
                await logTransaction(env, { type: 'donate', amount, userId, ts: Date.now() });

                return jsonResponse({ ok: true, invoiceLink }, 200, corsHeaders);
            }

            // Route: Create revive invoice (35 Stars for extra lives)
            if (url.pathname === '/create-revive-invoice' && request.method === 'POST') {
                const body = await request.json();
                const { userId, title, description } = body;

                const invoiceLink = await createInvoiceLink(botToken, {
                    title: title || '🔥 Продолжить заезд — Speed Quiz',
                    description: description || 'Восстановить 3 🏎️ жизни и сохранить рекорд!',
                    payload: JSON.stringify({ type: 'revive', userId: userId || 'anonymous', ts: Date.now() }),
                    currency: 'XTR',
                    prices: [{ label: title || 'Revive', amount: 35 }],
                });

                return jsonResponse({ ok: true, invoiceLink }, 200, corsHeaders);
            }

            // Route: Create hint pack invoice for Stars
            if (url.pathname === '/create-hints-invoice' && request.method === 'POST') {
                const body = await request.json();
                const { packType, userId, title, description } = body;

                let packTitle = title || '✂️ 5x 50/50';
                let amount = 15;
                if (packType === 'skip') {
                    if (!title) packTitle = '⏭️ 5x Skips';
                    amount = 25;
                } else if (packType === 'freeze') {
                    if (!title) packTitle = '⏱️ 5x Time Freeze';
                    amount = 20;
                } else if (packType === 'bundle') {
                    if (!title) packTitle = '⚡ Champion Bundle';
                    amount = 50;
                }

                const invoiceLink = await createInvoiceLink(botToken, {
                    title: packTitle,
                    description: description || `Speed Quiz Hint Pack`,
                    payload: JSON.stringify({ type: 'hints', packType, userId: userId || 'anonymous', ts: Date.now() }),
                    currency: 'XTR',
                    prices: [{ label: packTitle, amount }],
                });

                return jsonResponse({ ok: true, invoiceLink }, 200, corsHeaders);
            }

            // Route: Create VIP Gold Racer invoice (150 Stars)
            if (url.pathname === '/create-vip-invoice' && request.method === 'POST') {
                const body = await request.json();
                const { userId, title, description } = body;

                const invoiceLink = await createInvoiceLink(botToken, {
                    title: title || '🏅 VIP Gold Racer — Speed Quiz',
                    description: description || 'Forever VIP Status & Perks',
                    payload: JSON.stringify({ type: 'vip', userId: userId || 'anonymous', ts: Date.now() }),
                    currency: 'XTR',
                    prices: [{ label: title || 'VIP Gold Racer', amount: 150 }],
                });

                return jsonResponse({ ok: true, invoiceLink }, 200, corsHeaders);
            }

            // Route: Create bonus spin invoice (10 Stars)
            if (url.pathname === '/create-bonus-spin-invoice' && request.method === 'POST') {
                const body = await request.json();
                const { userId, title, description } = body;

                const invoiceLink = await createInvoiceLink(botToken, {
                    title: title || '🎡 Bonus Wheel Spin — Speed Quiz',
                    description: description || 'Extra Spin with boosted rewards!',
                    payload: JSON.stringify({ type: 'bonus_spin', userId: userId || 'anonymous', ts: Date.now() }),
                    currency: 'XTR',
                    prices: [{ label: title || 'Bonus Spin', amount: 10 }],
                });

                return jsonResponse({ ok: true, invoiceLink }, 200, corsHeaders);
            }

            // Route: Check VIP status
            if (url.pathname === '/check-vip' && request.method === 'GET') {
                const userId = url.searchParams.get('userId');
                if (!userId) return jsonResponse({ error: 'Missing userId' }, 400, corsHeaders);
                
                if (env.LEADERBOARD_KV) {
                    const vipStatus = await env.LEADERBOARD_KV.get(`vip_${userId}`);
                    return jsonResponse({ ok: true, isVip: vipStatus === 'true' }, 200, corsHeaders);
                }
                return jsonResponse({ ok: true, isVip: false }, 200, corsHeaders);
            }

            // Route: Set VIP status (called after successful payment via webhook)
            if (url.pathname === '/set-vip' && request.method === 'POST') {
                const body = await request.json();
                const { userId } = body;
                if (!userId) return jsonResponse({ error: 'Missing userId' }, 400, corsHeaders);
                
                if (env.LEADERBOARD_KV) {
                    await env.LEADERBOARD_KV.put(`vip_${userId}`, 'true');
                    return jsonResponse({ ok: true }, 200, corsHeaders);
                }
                return jsonResponse({ ok: true, note: 'No KV configured' }, 200, corsHeaders);
            }

            // Route: Telegram Webhook (handles pre_checkout_query + successful_payment)
            if (url.pathname === '/webhook' && request.method === 'POST') {
                const update = await request.json();

                // Handle pre_checkout_query — MUST answer within 10 seconds
                if (update.pre_checkout_query) {
                    await answerPreCheckoutQuery(botToken, update.pre_checkout_query.id, true);
                    return new Response('OK');
                }

                // Handle successful payment
                if (update.message?.successful_payment) {
                    const payment = update.message.successful_payment;
                    const chatId = update.message.chat.id;
                    const payload = JSON.parse(payment.invoice_payload || '{}');
                    
                    const totalAmount = payment.total_amount;

                    let thankMsg = '';
                    if (payload.type === 'revive') {
                        thankMsg = `🔥 Оплата принята! Ты восстановил 3 🏎️ жизни!\n\n⭐ Потрачено: ${totalAmount} Stars\n🙏 Спасибо за поддержку @shrtrcng!`;
                    } else if (payload.type === 'vip') {
                        // Set VIP status in KV
                        if (env.LEADERBOARD_KV && payload.userId) {
                            await env.LEADERBOARD_KV.put(`vip_${payload.userId}`, 'true');
                        }
                        thankMsg = `🏅 VIP GOLD RACER АКТИВИРОВАН!\n\n⭐ Потрачено: ${totalAmount} Stars\n🏅 Золотой бейдж, +3с таймер, 2 спина/день, +1 50/50\n\n🙏 Спасибо за поддержку @shrtrcng!`;
                    } else if (payload.type === 'bonus_spin') {
                        thankMsg = `🎡 Бонусный спин оплачен!\n\n⭐ Потрачено: ${totalAmount} Stars\n🏎️ Удачи с улучшенными призами!`;
                    } else if (payload.type === 'hints') {
                        thankMsg = `🎉 Покупка подтверждена!\n\n⭐ Потрачено: ${totalAmount} Stars\n🏎️ Подсказки добавлены в твой арсенал!`;
                    } else {
                        thankMsg = `🏆 СПАСИБО ЗА ПОДДЕРЖКУ!\n\n⭐ Донат: ${totalAmount} Stars\n🏎️ Ты помогаешь развивать Speed Quiz!\n\n📸 @shrtrcng`;
                    }

                    // Log successful payment
                    await logTransaction(env, { 
                        type: payload.type || 'donate', 
                        amount: totalAmount, 
                        userId: payload.userId, 
                        status: 'paid',
                        ts: Date.now() 
                    });

                    await sendMessage(botToken, chatId, thankMsg);
                    return new Response('OK');
                }

                return new Response('OK');
            }

            // Global in-memory fallback leaderboard if KV is not bound
            if (!globalThis.MEMORY_LEADERBOARD) {
                globalThis.MEMORY_LEADERBOARD = [
                    { userId: 'bot1', name: '🏎️ Apex Racer', score: 2850, gamesPlayed: 42, isVip: true },
                    { userId: 'bot2', name: '🔥 Turbo Drift', score: 2420, gamesPlayed: 35, isVip: false },
                    { userId: 'bot3', name: '⚡ Wangan Legend', score: 1980, gamesPlayed: 28, isVip: true },
                    { userId: 'bot4', name: '🏁 Nitro King', score: 1650, gamesPlayed: 19, isVip: false },
                    { userId: 'bot5', name: '🏆 Shift Master', score: 1420, gamesPlayed: 15, isVip: false }
                ];
            }

            // Route: Submit Bug Report
            if (url.pathname === '/submit-report' && request.method === 'POST') {
                const body = await request.json();
                const { userId, userName, issueText, questionText } = body;

                if (!issueText && !questionText) {
                    return jsonResponse({ error: 'Empty report text' }, 400, corsHeaders);
                }

                const reportEntry = {
                    id: 'rep_' + Date.now(),
                    userId: userId || 'anonymous',
                    userName: userName || 'Guest Racer',
                    questionText: questionText || '',
                    issueText: issueText || '',
                    ts: Date.now(),
                    dateStr: new Date().toISOString()
                };

                // Store in KV if available
                if (env.LEADERBOARD_KV) {
                    try {
                        let reports = await env.LEADERBOARD_KV.get('bug_reports', { type: 'json' }) || [];
                        reports.push(reportEntry);
                        if (reports.length > 300) reports = reports.slice(-300);
                        await env.LEADERBOARD_KV.put('bug_reports', JSON.stringify(reports));
                    } catch (e) {
                        console.error('KV Bug report error:', e);
                    }
                }

                // Send Telegram Notification to Admin if ADMIN_CHAT_ID or BOT_TOKEN is present
                const adminChatId = env.ADMIN_CHAT_ID || env.TELEGRAM_ADMIN_ID;
                if (adminChatId) {
                    const msgText = `🚨 <b>НОВЫЙ РЕПОРТ ОБ ОШИБКЕ — Speed Quiz</b>\n\n👤 <b>От:</b> ${reportEntry.userName} (ID: <code>${reportEntry.userId}</code>)\n📝 <b>Сообщение:</b>\n${reportEntry.issueText}\n\n⏰ <b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
                    try {
                        await sendMessage(botToken, adminChatId, msgText);
                    } catch (err) {
                        console.error('Failed to notify admin via bot:', err);
                    }
                }

                return jsonResponse({ ok: true, message: 'Report submitted successfully' }, 200, corsHeaders);
            }

            // Route: View Submitted Bug Reports
            if (url.pathname === '/reports' && request.method === 'GET') {
                if (env.LEADERBOARD_KV) {
                    const reports = await env.LEADERBOARD_KV.get('bug_reports', { type: 'json' }) || [];
                    return jsonResponse({ ok: true, total: reports.length, reports: reports.reverse() }, 200, corsHeaders);
                }
                return jsonResponse({ ok: true, total: 0, reports: [] }, 200, corsHeaders);
            }

            // Route: Submit Score to Global Shared Leaderboard
            if (url.pathname === '/submit-score' && request.method === 'POST') {
                const body = await request.json();
                const { userId, name, score, gamesPlayed, totalCorrect, isVip: playerIsVip } = body;
                if (!score || !name) {
                    return jsonResponse({ error: 'Invalid parameters' }, 400, corsHeaders);
                }

                if (env.LEADERBOARD_KV) {
                    let leaders = await env.LEADERBOARD_KV.get('top_leaders', { type: 'json' }) || [];
                    let existing = leaders.find(l => l.userId === userId || l.name === name);
                    const isVip = await env.LEADERBOARD_KV.get(`vip_${userId}`) || (playerIsVip ? 'true' : 'false');
                    
                    if (existing) {
                        if (score > existing.score) existing.score = score;
                        existing.gamesPlayed = (existing.gamesPlayed || 0) + 1;
                        if (totalCorrect) existing.totalCorrect = totalCorrect;
                        existing.isVip = isVip === 'true';
                    } else {
                        leaders.push({ 
                            userId: userId || 'user_' + Date.now(), name, score, 
                            gamesPlayed: gamesPlayed || 1, 
                            totalCorrect: totalCorrect || 0, 
                            isVip: isVip === 'true',
                            ts: Date.now() 
                        });
                    }
                    leaders.sort((a, b) => b.score - a.score);
                    leaders = leaders.slice(0, 1000);
                    await env.LEADERBOARD_KV.put('top_leaders', JSON.stringify(leaders));
                    return jsonResponse({ ok: true, leaders: leaders.slice(0, 1000) }, 200, corsHeaders);
                } else {
                    // Shared Memory fallback
                    let existing = globalThis.MEMORY_LEADERBOARD.find(l => l.userId === userId || l.name === name);
                    if (existing) {
                        if (score > existing.score) existing.score = score;
                        existing.gamesPlayed = (existing.gamesPlayed || 0) + 1;
                        existing.isVip = existing.isVip || playerIsVip;
                    } else {
                        globalThis.MEMORY_LEADERBOARD.push({
                            userId: userId || 'user_' + Date.now(), name, score,
                            gamesPlayed: gamesPlayed || 1,
                            isVip: playerIsVip || false,
                            ts: Date.now()
                        });
                    }
                    globalThis.MEMORY_LEADERBOARD.sort((a, b) => b.score - a.score);
                    globalThis.MEMORY_LEADERBOARD = globalThis.MEMORY_LEADERBOARD.slice(0, 1000);
                    return jsonResponse({ ok: true, leaders: globalThis.MEMORY_LEADERBOARD }, 200, corsHeaders);
                }
            }

            // Route: Get Top Shared Leaderboard (up to 1000)
            if (url.pathname === '/leaderboard' && request.method === 'GET') {
                const limit = parseInt(url.searchParams.get('limit') || '1000');
                if (env.LEADERBOARD_KV) {
                    let leaders = await env.LEADERBOARD_KV.get('top_leaders', { type: 'json' }) || [];
                    if (leaders.length === 0) {
                        leaders = [...globalThis.MEMORY_LEADERBOARD];
                    }
                    return jsonResponse({ ok: true, leaders: leaders.slice(0, Math.min(limit, 1000)) }, 200, corsHeaders);
                }
                return jsonResponse({ ok: true, leaders: globalThis.MEMORY_LEADERBOARD.slice(0, Math.min(limit, 1000)) }, 200, corsHeaders);
            }

            // Route: Reset Leaderboard
            if (url.pathname === '/reset-leaderboard') {
                if (env.LEADERBOARD_KV) {
                    await env.LEADERBOARD_KV.put('top_leaders', JSON.stringify([]));
                }
                globalThis.MEMORY_LEADERBOARD = [];
                return jsonResponse({ ok: true, message: 'Leaderboard reset successfully' }, 200, corsHeaders);
            }

            // Route: Transaction stats
            if (url.pathname === '/tx-stats' && request.method === 'GET') {
                if (env.LEADERBOARD_KV) {
                    const txLog = await env.LEADERBOARD_KV.get('tx_log', { type: 'json' }) || [];
                    const totalRevenue = txLog.filter(t => t.status === 'paid').reduce((sum, t) => sum + (t.amount || 0), 0);
                    const totalTx = txLog.length;
                    return jsonResponse({ ok: true, totalRevenue, totalTx, recent: txLog.slice(-20) }, 200, corsHeaders);
                }
                return jsonResponse({ ok: true, totalRevenue: 0, totalTx: 0, recent: [] }, 200, corsHeaders);
            }

            // Health check
            if (url.pathname === '/health') {
                return jsonResponse({ status: 'ok', service: 'Speed Quiz Payments, Global Leaderboard, Reports & VIP' }, 200, corsHeaders);
            }

            return jsonResponse({ error: 'Not found' }, 404, corsHeaders);

        } catch (err) {
            console.error('Worker error:', err);
            return jsonResponse({ error: err.message }, 500, corsHeaders);
        }
    }
};

// --- Telegram Bot API helpers ---

async function createInvoiceLink(botToken, params) {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: params.title,
            description: params.description,
            payload: params.payload,
            provider_token: '', // Empty for Stars
            currency: params.currency,
            prices: params.prices,
        }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
    return data.result;
}

async function answerPreCheckoutQuery(botToken, queryId, ok, errorMessage) {
    await fetch(`https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            pre_checkout_query_id: queryId,
            ok: ok,
            error_message: errorMessage,
        }),
    });
}

async function sendMessage(botToken, chatId, text) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
}

async function logTransaction(env, txData) {
    if (!env.LEADERBOARD_KV) return;
    try {
        let txLog = await env.LEADERBOARD_KV.get('tx_log', { type: 'json' }) || [];
        txLog.push(txData);
        // Keep last 500 transactions
        if (txLog.length > 500) txLog = txLog.slice(-500);
        await env.LEADERBOARD_KV.put('tx_log', JSON.stringify(txLog));
    } catch (e) {
        console.error('Failed to log transaction:', e);
    }
}

function jsonResponse(data, status, corsHeaders) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}
