import indexHtml from "./index.html";

/**
 * Worker 主代码：订单管理系统后端
 * 绑定了 R2 存储桶 R2_BUCKET
 */

// --- 常量定义 ---
const DATA_KEY = "orders/orders_data.json"; // 存储订单数据的主文件
const CONFIG_KEY = "system/config.json"; // 存储 API 配置的文件
const IMAGE_PREFIX = "images/"; // R2 中图片存储前缀

// --- 辅助函数 ---

/** 将 ArrayBuffer 转换为 Base64 字符串 (Workers 兼容) */
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/** 读取 R2 对象并解析为 JSON，如果不存在则返回默认值 */
async function getR2Json(env, key, defaultValue = null) {
    const object = await env.R2_BUCKET.get(key);
    if (object === null) {
        return defaultValue;
    }
    try {
        return await object.json();
    } catch (e) {
        console.error(`Failed to parse JSON from R2 key: ${key}`, e);
        return defaultValue;
    }
}

/** 写入 JSON 对象到 R2 */
async function putR2Json(env, key, data) {
    await env.R2_BUCKET.put(key, JSON.stringify(data, null, 2), {
        httpMetadata: { contentType: "application/json" }
    });
}

// --- API 路由处理函数 ---

/** GET /api/config: 获取配置 */
async function handleGetConfig(env) {
    const defaultConfig = {
        api_provider: "openai",
        api_url: "https://api.openai.com/v1/chat/completions",
        model_name: "gpt-4o-mini",
        api_key: ""
    };
    const config = await getR2Json(env, CONFIG_KEY, defaultConfig);
    const { api_key, ...safeConfig } = config;
    return new Response(JSON.stringify(safeConfig), {
        headers: { "Content-Type": "application/json" }
    });
}

/** POST /api/config: 更新配置 */
async function handleUpdateConfig(request, env) {
    try {
        const newConfig = await request.json();
        const existingConfig = await getR2Json(env, CONFIG_KEY, {});
        
        const configToSave = {
            api_provider: newConfig.api_provider || existingConfig.api_provider || 'openai',
            api_url: newConfig.api_url || existingConfig.api_url || '',
            model_name: newConfig.model_name || existingConfig.model_name || '',
            api_key: newConfig.api_key || existingConfig.api_key || ''
        };
        
        await putR2Json(env, CONFIG_KEY, configToSave);

        return new Response(JSON.stringify({ message: "配置更新成功" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: "更新配置失败", details: e.message }), {
            status: 400
        });
    }
}

/** POST /api/upload: 上传图片并识别订单信息 */
async function handleUpload(request, env) {
    const results = [];
    let existingOrders;
    let config;

    try {
        // 1. Fetch shared resources once
        config = await getR2Json(env, CONFIG_KEY, {});
        existingOrders = await getR2Json(env, DATA_KEY, []);
        const { api_provider = 'openai', api_url, model_name, api_key } = config;

        if (!api_key) {
            throw new Error("API 密钥未设置。请先在网页的配置部分输入并保存您的 API 密钥。");
        }
        if (!model_name) {
            throw new Error("AI 模型名称缺失，请先配置");
        }
        if (api_provider === 'openai' && !api_url) {
            throw new Error("OpenAI 兼容 API 的 URL 缺失，请先配置");
        }

        const formData = await request.formData();
        const imageFiles = formData.getAll("orderImages");

        if (!imageFiles || imageFiles.length === 0) {
            return new Response(JSON.stringify({ error: "未接收到任何图片文件" }), { status: 400 });
        }

        // 2. Process each file individually
        for (const imageFile of imageFiles) {
            if (!imageFile || imageFile.size === 0) {
                results.push({ success: false, filename: imageFile.name || 'unknown', error: "空文件或无效文件" });
                continue;
            }

            try {
                const arrayBuffer = await imageFile.arrayBuffer();
                const base64Image = arrayBufferToBase64(arrayBuffer);
                const imageContentType = imageFile.type || 'image/jpeg';

                const prompt = `请从手写订单图片中识别出客户名称(customer_name)、一个包含所有货物详情的JSON数组(items)、订单总金额(total_amount, 只返回数字)、和订单日期(order_date, 格式YYYY-MM-DD)，并严格以 JSON 格式返回结果。在items数组中，每个货物都应该是一个包含'name'(货物名称), 'unit'(单位, 例如'件'、'箱'), 'quantity'(数量, 数字), 'unit_price'(单价, 数字), 和 'amount'(该项总金额, 数字)的对象。确保所有价格相关的字段都是数字。`;
                let extractedJson;

                if (api_provider === 'gemini') {
                    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model_name}:generateContent?key=${api_key}`;
                    const geminiResponse = await fetch(geminiUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: imageContentType, data: base64Image } }] }],
                            generationConfig: { response_mime_type: "application/json" }
                        })
                    });
                    if (!geminiResponse.ok) {
                        const errorText = await geminiResponse.text();
                        throw new Error(`Gemini API 错误: ${geminiResponse.status} - ${errorText}`);
                    }
                    const geminiData = await geminiResponse.json();
                    extractedJson = geminiData.candidates[0].content.parts[0].text;
                } else { // OpenAI compatible
                    const aiResponse = await fetch(api_url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${api_key}` },
                        body: JSON.stringify({
                            model: model_name,
                            messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${imageContentType};base64,${base64Image}` } }] }],
                            response_format: { type: "json_object" }
                        })
                    });
                    if (!aiResponse.ok) {
                        const errorText = await aiResponse.text();
                        throw new Error(`AI API 错误: ${aiResponse.status} - ${errorText}`);
                    }
                    const aiData = await aiResponse.json();
                    extractedJson = aiData.choices[0].message.content;
                }

                if (extractedJson.startsWith('```json')) {
                    extractedJson = extractedJson.substring(7, extractedJson.lastIndexOf('```')).trim();
                }
                const orderData = JSON.parse(extractedJson);

                // --- Order ID Generation (in-memory) ---
                const orderDate = orderData.order_date || new Date().toISOString().substring(0, 10);
                const datePrefix = orderDate.replace(/-/g, '');
                let maxSeq = 0;
                existingOrders.forEach(order => {
                    if (order.order_id.startsWith(datePrefix)) {
                        const seq = parseInt(order.order_id.split('-')[1], 10);
                        if (seq > maxSeq) maxSeq = seq;
                    }
                });
                const newSeq = maxSeq + 1;
                const orderId = `${datePrefix}-${String(newSeq).padStart(2, '0')}`;
                // --- End ID Generation ---

                const imageR2Key = `${IMAGE_PREFIX}${orderId}-${imageFile.name}`;
                await env.R2_BUCKET.put(imageR2Key, arrayBuffer, { httpMetadata: { contentType: imageContentType } });

                const newRecord = {
                    order_id: orderId,
                    customer_name: orderData.customer_name || 'N/A',
                    items: orderData.items || [],
                    total_amount: parseFloat(orderData.total_amount) || 0,
                    order_date: orderDate,
                    upload_date: new Date().toISOString(),
                    image_r2_key: imageR2Key
                };

                existingOrders.push(newRecord); // Add to in-memory list for next ID calculation
                results.push({ success: true, filename: imageFile.name, data: newRecord });

            } catch (e) {
                console.error(`处理文件 ${imageFile.name} 失败:`, e.stack);
                results.push({ success: false, filename: imageFile.name, error: e.message });
            }
        }

        // 3. Save all successful orders at once
        if (results.some(r => r.success)) {
            await putR2Json(env, DATA_KEY, existingOrders);
        }

        return new Response(JSON.stringify(results), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });

    } catch (e) {
        // This catches initial setup errors (e.g., loading config)
        console.error("处理订单失败:", e.stack);
        return new Response(JSON.stringify({ error: "处理订单失败", details: e.message }), {
            status: 500
        });
    }
}

/** POST /api/order/update: 更新单个订单字段 */
async function handleUpdateOrder(request, env) {
    try {
        const { order_id, field, value, item_index, item_field } = await request.json();

        if (!order_id || !field) {
            return new Response(JSON.stringify({ error: "缺少 order_id 或 field 参数" }), { status: 400 });
        }

        const allOrders = await getR2Json(env, DATA_KEY, []);
        const orderIndex = allOrders.findIndex(o => o.order_id === order_id);

        if (orderIndex === -1) {
            return new Response(JSON.stringify({ error: "找不到指定的订单" }), { status: 404 });
        }

        const orderToUpdate = allOrders[orderIndex];
        const numericFields = ['quantity', 'unit_price', 'amount', 'total_amount'];

        if (field === "items" && item_index != null && item_field) {
            if (orderToUpdate.items && orderToUpdate.items[item_index]) {
                let finalValue = value;
                if (numericFields.includes(item_field)) {
                    finalValue = parseFloat(value) || 0;
                }
                orderToUpdate.items[item_index][item_field] = finalValue;
            } else {
                return new Response(JSON.stringify({ error: "找不到指定的货物索引" }), { status: 400 });
            }
        } else {
            let finalValue = value;
            if (numericFields.includes(field)) {
                finalValue = parseFloat(value) || 0;
            }
            orderToUpdate[field] = finalValue;
        }

        await putR2Json(env, DATA_KEY, allOrders);

        return new Response(JSON.stringify({ message: "订单更新成功" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });

    } catch (e) {
        console.error("更新订单失败:", e.stack);
        return new Response(JSON.stringify({ error: "更新订单失败", details: e.message }), {
            status: 500
        });
    }
}

/** POST /api/order/delete: 删除一个订单 */
async function handleDeleteOrder(request, env) {
    try {
        const { order_id } = await request.json();
        if (!order_id) {
            return new Response(JSON.stringify({ error: "缺少 order_id 参数" }), { status: 400 });
        }

        const allOrders = await getR2Json(env, DATA_KEY, []);
        const updatedOrders = allOrders.filter(o => o.order_id !== order_id);

        if (updatedOrders.length === allOrders.length) {
            return new Response(JSON.stringify({ error: "找不到要删除的订单" }), { status: 404 });
        }

        await putR2Json(env, DATA_KEY, updatedOrders);

        return new Response(JSON.stringify({ message: "订单删除成功" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });

    } catch (e) {
        console.error("删除订单失败:", e.stack);
        return new Response(JSON.stringify({ error: "删除订单失败", details: e.message }), {
            status: 500
        });
    }
}


// --- 其他 API 路由 ---

/** GET /api/orders: 获取所有订单数据 */
async function handleGetOrders(env) {
    const orders = await getR2Json(env, DATA_KEY, []);
    orders.sort((a, b) => new Date(b.upload_date) - new Date(a.upload_date));
    return new Response(JSON.stringify(orders), {
        headers: { "Content-Type": "application/json" }
    });
}

/** GET /api/export: 导出订单数据为 CSV */
async function handleExportOrders(request, env) {
    const { protocol, host } = new URL(request.url);
    const baseUrl = `${protocol}//${host}`;

    const orders = await getR2Json(env, DATA_KEY, []);
    if (orders.length === 0) {
        return new Response("无订单数据可导出", { status: 404 });
    }
    const headers = ["订单ID", "客户名称", "订单日期", "总金额", "货物名称", "单位", "数量", "单价", "货物金额", "上传时间", "图片链接"];
    
    let csv = "\uFEFF" + headers.join(",") + "\n";
    orders.forEach(order => {
        const imageUrl = order.image_r2_key ? `${baseUrl}/api/images/${order.image_r2_key}` : "";
        if (order.items && order.items.length > 0) {
            order.items.forEach(item => {
                const rowData = [
                    order.order_id,
                    order.customer_name,
                    order.order_date,
                    order.total_amount,
                    item.name || '',
                    item.unit || '',
                    item.quantity || '',
                    item.unit_price || '',
                    item.amount || '',
                    order.upload_date,
                    imageUrl
                ];
                const row = rowData.map(value => {
                    let strValue = value != null ? String(value).replace(/"/g, '""') : "";
                    if (strValue.includes(',')) strValue = `"${strValue}"`;
                    return strValue;
                }).join(",");
                csv += row + "\n";
            });
        } else {
            const rowData = [order.order_id, order.customer_name, order.order_date, order.total_amount, "", "", "", "", "", order.upload_date, imageUrl];
            const row = rowData.map(value => {
                let strValue = value != null ? String(value).replace(/"/g, '""') : "";
                if (strValue.includes(',')) strValue = `"${strValue}"`;
                return strValue;
            }).join(",");
            csv += row + "\n";
        }
    });

    return new Response(csv, {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="orders_export_${new Date().toISOString().substring(0, 10)}.csv"`
        },
    });
}

async function handleExportHtml(request, env) {
    const { searchParams, protocol, host } = new URL(request.url);
    const baseUrl = `${protocol}//${host}`;
    let allOrders = await getR2Json(env, DATA_KEY, []);

    // Filtering logic
    const selectedCustomers = searchParams.getAll('customer');
    if (selectedCustomers.length > 0) {
        allOrders = allOrders.filter(order => selectedCustomers.includes(order.customer_name));
    }
    const orderDateStart = searchParams.get('orderDateStart');
    if (orderDateStart) {
        allOrders = allOrders.filter(order => order.order_date >= orderDateStart);
    }
    const orderDateEnd = searchParams.get('orderDateEnd');
    if (orderDateEnd) {
        allOrders = allOrders.filter(order => order.order_date <= orderDateEnd);
    }
    const uploadDateStart = searchParams.get('uploadDateStart');
    if (uploadDateStart) {
        allOrders = allOrders.filter(order => order.upload_date.substring(0, 10) >= uploadDateStart);
    }
    const uploadDateEnd = searchParams.get('uploadDateEnd');
    if (uploadDateEnd) {
        allOrders = allOrders.filter(order => order.upload_date.substring(0, 10) <= uploadDateEnd);
    }
    
    const ordersToExport = allOrders;

    if (ordersToExport.length === 0) {
        return new Response("无匹配的订单数据可导出", { status: 404 });
    }

    const tableRows = ordersToExport.map(order => {
        let imageHtml = '无图片';
        if (order.image_r2_key) {
            const imageUrl = `${baseUrl}/api/images/${order.image_r2_key}`;
            imageHtml = `<img src="${imageUrl}" style="width: 100%; height: auto; display: block;" />`;
        }

        const itemsHtml = (order.items && order.items.length > 0)
            ? '<ul>' + order.items.map(item => `<li>${item.name || ''} - 数量: ${item.quantity || 0}, 单价: ${item.unit_price || 0}, 金额: ${item.amount || 0}</li>`).join('') + '</ul>'
            : '无货物详情';

        return `
            <tr>
                <td>${order.order_id || ''}</td>
                <td>${order.customer_name || ''}</td>
                <td>${order.order_date || ''}</td>
                <td>${(order.total_amount || 0).toFixed(2)}</td>
                <td>${itemsHtml}</td>
                <td>${new Date(order.upload_date).toLocaleString()}</td>
                <td>${imageHtml}</td>
            </tr>
        `;
    }).join('');

    const fullHtml = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <title>订单导出</title>
            <style>
                body { font-family: sans-serif; }
                table { width: 100%; border-collapse: collapse; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
                th { background-color: #f2f2f2; }
                img { max-width: 200px; max-height: 200px; }
                ul { padding-left: 20px; margin: 0; }
            </style>
        </head>
        <body>
            <h1>订单列表</h1>
            <table>
                <thead>
                    <tr>
                        <th>订单 ID</th>
                        <th>客户名称</th>
                        <th>订单日期</th>
                        <th>订单总额</th>
                        <th>货物详情</th>
                        <th>上传时间</th>
                        <th>订单图片</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
        </body>
        </html>
    `;

    return new Response(fullHtml, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Disposition": `attachment; filename="orders_export_${new Date().toISOString().substring(0, 10)}.html"`
        },
    });
}

async function handleGetImage(request, env) {
    const url = new URL(request.url);
    const imageKey = url.pathname.substring("/api/images/".length);
    if (!imageKey) {
        return new Response("Image key missing", { status: 400 });
    }
    try {
        const object = await env.R2_BUCKET.get(imageKey);
        if (object === null) {
            return new Response("Image not found", { status: 404 });
        }
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=86400");
        return new Response(object.body, { headers });
    } catch (e) {
        console.error("Failed to fetch image from R2:", e);
        return new Response("Error fetching image", { status: 500 });
    }
}

// --- Worker 入口与路由 ---

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === "/") {
            return new Response(indexHtml, {
                headers: { "Content-Type": "text/html;charset=UTF-8" },
            });
        }

        if (url.pathname.startsWith("/api/")) {
            const path = url.pathname;
            if (request.method === "GET") {
                if (path === "/api/config") return handleGetConfig(env);
                if (path === "/api/orders") return handleGetOrders(env);
                if (path === "/api/export") return handleExportOrders(request, env);
                if (path === "/api/export-html") return handleExportHtml(request, env);
                if (path.startsWith("/api/images/")) return handleGetImage(request, env);
            } else if (request.method === "POST") {
                if (path === "/api/config") return handleUpdateConfig(request, env);
                if (path === "/api/upload") return handleUpload(request, env);
                if (path === "/api/order/update") return handleUpdateOrder(request, env);
                if (path === "/api/order/delete") return handleDeleteOrder(request, env);
            }
            return new Response("API Not Found", { status: 404 });
        }

        return new Response("Not Found", { status: 404 });
    }
};
