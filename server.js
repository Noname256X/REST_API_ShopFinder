const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const pool = require('./config/db'); 
require('dotenv').config();

const app = express();

const { downloadImages } = require('./imageDownloader');


const { cleanupImages } = require('./cleanupService'); // curl -X POST http://localhost:3000/api/cleanup

app.post('/api/cleanup', async (req, res) => {
    try {
        const result = await cleanupImages();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: 'Ошибка при очистке изображений',
            details: error.message
        });
    }
});



app.use(cors());
app.use(express.json());

const server = require('http').createServer(app);

const wss = new WebSocket.Server({ server });

const clients = new Map();

function sendToClient(ip, message) {
    const ws = clients.get(ip);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}


wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`Новое подключение к WebSocket от ${ip}`);
    clients.set(ip, ws);
    
    ws.on('close', () => {
        clients.delete(ip);
        console.log(`Соединение с WebSocket закрыто для ${ip}`);
    });
});


const queues = new Map();

function getQueueForIp(ip) {
    if (!queues.has(ip)) {
        queues.set(ip, {
            tasks: [],
            isProcessing: false
        });
    }
    return queues.get(ip);
}


const authRoutes = require('./routes/authRoutes');
app.use('/api/auth', authRoutes);

app.post('/api/search', (req, res) => {
    const { query, ip, pageNumber = 8, marketplaces } = req.body;
    
    const activeMarketplaces = marketplaces || [
        'Ozon', 'Wildberries', 'YandexMarket', 'MagnitMarket', 
        'DNS', 'Citilink', 'M_Video', 'Aliexpress', 
        'Joom', 'Shop_mts', 'Technopark', 'Lamoda'
    ];

    const queue = getQueueForIp(ip);
    
    activeMarketplaces.forEach(mp => {
        queue.tasks.push({
            ip,
            query,
            marketplace: mp,
            pageNumber 
        });
    });
    
    if (!queue.isProcessing) {
        processQueueForIp(ip);
    }
    
    res.json({ status: 'Search started' });
});

async function processQueueForIp(ip) {
    const queue = getQueueForIp(ip);
    if (queue.isProcessing || queue.tasks.length === 0) return;
    
    queue.isProcessing = true;
    const task = queue.tasks[0]; 
    
    console.log(`Обработка: ${task.marketplace} для ${task.ip}`);
    
    try {
        sendToClient(task.ip, {
            type: 'status',
            message: `${task.marketplace}: Начало парсинга`
        });
        
        const response = await axios.post('http://192.168.1.4:5000/parse', {
            query: task.query,
            marketplace: task.marketplace,
            ip: task.ip,
            pageNumber: task.pageNumber
        }, { timeout: 500000 }); 
        
        await waitForCompletion(task.ip, task.marketplace);
        
        console.log(`Успешно обработан ${task.marketplace}`);
        
        queue.tasks.shift();
        
        sendToClient(task.ip, {
            type: 'status',
            message: `${task.marketplace}: Парсинг завершен`
        });
        
    } catch (error) {
        console.error(`Ошибка обработки ${task.marketplace}:`, error);
        
        sendToClient(task.ip, {
            type: 'status',
            message: `${task.marketplace}: Ошибка парсинга - ${error.message}`
        });
        
        queue.tasks.shift(); 
    } finally {
        queue.isProcessing = false;
        
        if (queue.tasks.length > 0) {
            processQueueForIp(ip);
        } else {
            queues.delete(ip);
        }
    }
}

function waitForCompletion(ip, marketplace) {
    return new Promise((resolve) => {
        setTimeout(resolve, 30000); 
    });
}

app.post('/api/data', async (req, res) => {
    console.log('Полученные данные:', req.body);
    const { ip, marketplace, data } = req.body;
    
    try {
        let processedData;
        if (Array.isArray(data)) {
            processedData = [];
            for (const product of data) {
                const processedProduct = await downloadImages(ip, marketplace, product);
                processedData.push(processedProduct);
            }
        } else {
            processedData = await downloadImages(ip, marketplace, data);
        }
        
        sendToClient(ip, {
            type: 'data',
            marketplace: marketplace,
            data: processedData
        });
        
        res.json({ 
            status: 'success',
            message: 'Data received and images downloaded successfully'
        });
    } catch (error) {
        console.error('Ошибка при обработке данных:', error);
        sendToClient(ip, {
            type: 'error',
            message: `Ошибка при загрузке изображений: ${error.message}`
        });
        res.status(500).json({ 
            status: 'error',
            error: 'Ошибка при обработке данных',
            details: error.message
        });
    }
});

app.post('/api/status', (req, res) => {
    const { ip, message } = req.body;
    
    sendToClient(ip, {
        type: 'status',
        message: message
    });
    
    res.json({ status: 'Status received' });
});

app.post('/api/users/soft-delete', async (req, res) => {
    try {
        const { user_id } = req.body;
        
        if (!user_id) {
            return res.status(400).json({ 
                status: 'error',
                error: 'Не указан ID пользователя' 
            });
        }

        const [user] = await pool.execute(
            'SELECT id FROM Users WHERE id = ? AND deleted_at IS NULL',
            [user_id]
        );

        if (user.length === 0) {
            return res.status(404).json({ 
                status: 'error',
                error: 'Пользователь не найден или уже удален' 
            });
        }

        const [userProducts] = await pool.execute(
            'SELECT product_id FROM Users_Products WHERE user_id = ?',
            [user_id]
        );

        await pool.execute(
            'DELETE FROM Users_Products WHERE user_id = ?',
            [user_id]
        );

        for (const up of userProducts) {
            const [relations] = await pool.execute(
                'SELECT id FROM Users_Products WHERE product_id = ?',
                [up.product_id]
            );
            
            if (relations.length === 0) {
                await pool.execute(
                    'DELETE FROM Product_Photos WHERE product_id = ?',
                    [up.product_id]
                );
                await pool.execute(
                    'DELETE FROM Products WHERE id = ?',
                    [up.product_id]
                );
            }
        }

        await pool.execute(
            'UPDATE Users SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?',
            [user_id]
        );

        res.json({ 
            status: 'success',
            message: 'Аккаунт деактивирован, все связанные данные удалены'
        });

    } catch (error) {
        console.error('Ошибка при деактивации аккаунта:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Ошибка при деактивации аккаунта',
            details: error.message
        });
    }
});

app.get('/api/favorites', async (req, res) => {
    try {
        const userId = req.query.user_id;
        
        if (!userId) {
            return res.status(400).json({ 
                status: 'error',
                error: 'Не указан ID пользователя' 
            });
        }

        const [products] = await pool.execute(`
            SELECT p.*, 
                   (SELECT GROUP_CONCAT(pp.photo_url SEPARATOR ',') 
                    FROM Product_Photos pp 
                    WHERE pp.product_id = p.id) as photos
            FROM Products p
            JOIN Users_Products up ON p.id = up.product_id
            WHERE up.user_id = ?
            ORDER BY up.added_at DESC
        `, [userId]);

        if (products.length === 0) {
            return res.status(200).json({ 
                status: 'success',
                products: [],
                message: 'У пользователя нет избранных товаров' 
            });
        }

        const formattedProducts = products.map(product => ({
            ...product,
            photos: product.photos ? product.photos.split(',') : []
        }));

        res.json({ 
            status: 'success',
            products: formattedProducts
        });

    } catch (error) {
        console.error('Ошибка при получении избранных товаров:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Ошибка при получении избранных товаров',
            details: error.message
        });
    }
});

app.post('/api/favorites', async (req, res) => {
    try {
        const { user_id, product } = req.body;
        const { marketplace, title, price, rating, reviews, link, article, images } = product;
        
        if (!user_id || !marketplace || !title || !price) {
            return res.status(400).json({ 
                status: 'error',
                error: 'Недостаточно данных' 
            });
        }

        const [user] = await pool.execute('SELECT id FROM Users WHERE id = ?', [user_id]);
        if (user.length === 0) {
            return res.status(404).json({ 
                status: 'error',
                error: 'Пользователь не найден' 
            });
        }

        const priceValue = parseInt(price.toString().replace(/\D/g, '')) || 0;
        const ratingValue = parseFloat(rating) || 0;
        const reviewsValue = parseInt(reviews) || 0;

        const [existingProduct] = await pool.execute(
            'SELECT id FROM Products WHERE link_url = ?',
            [link]
        );

        let productId;
        if (existingProduct.length > 0) {
            productId = existingProduct[0].id;
            
            await pool.execute(
                'UPDATE Products SET product_name = ?, price = ?, rating = ?, reviews_count = ? WHERE id = ?',
                [title, priceValue, ratingValue, reviewsValue, productId]
            );
        } else {
            const [productResult] = await pool.execute(
                'INSERT INTO Products (product_name, link_url, price, rating, reviews_count) VALUES (?, ?, ?, ?, ?)',
                [title, link, priceValue, ratingValue, reviewsValue]
            );
            productId = productResult.insertId;

            if (images && images.length > 0) {
                for (const image of images) {
                    await pool.execute(
                        'INSERT INTO Product_Photos (product_id, photo_url) VALUES (?, ?)',
                        [productId, `http://192.168.1.4:3000/images/not%20in%20the%20database/${image}`]
                    );
                }
            }
        }

        const [existingRelation] = await pool.execute(
            'SELECT id FROM Users_Products WHERE user_id = ? AND product_id = ?',
            [user_id, productId]
        );

        if (existingRelation.length === 0) {
            await pool.execute(
                'INSERT INTO Users_Products (user_id, product_id) VALUES (?, ?)',
                [user_id, productId]
            );
        }

        res.status(201).json({ 
            status: 'success',
            message: 'Товар успешно добавлен в избранное',
            productId: productId
        });

    } catch (error) {
        console.error('Ошибка при добавлении в избранное:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Ошибка при добавлении в избранное',
            details: error.message
        });
    }
});


app.get('/api/favorites/last', async (req, res) => {
    try {
        const userId = req.query.user_id;
        
        if (!userId) {
            return res.status(400).json({ 
                status: 'error',
                error: 'Не указан ID пользователя' 
            });
        }

        const [results] = await pool.execute(`
            SELECT p.*, up.added_at, 
                   (SELECT GROUP_CONCAT(pp.photo_url SEPARATOR ',') 
                    FROM Product_Photos pp 
                    WHERE pp.product_id = p.id) as photos
            FROM Products p
            JOIN Users_Products up ON p.id = up.product_id
            WHERE up.user_id = ?
            ORDER BY up.added_at DESC
            LIMIT 1
        `, [userId]);

        if (results.length === 0) {
            return res.status(404).json({ 
                status: 'error',
                error: 'У пользователя нет избранных товаров' 
            });
        }

        const product = results[0];
        
        let photos = [];
        if (product.photos) {
            photos = product.photos.split(',');
        }

        const responseProduct = {
            ...product,
            photos: photos
        };

        res.json({ 
            status: 'success',
            product: responseProduct
        });

    } catch (error) {
        console.error('Ошибка при получении последнего товара:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Ошибка при получении последнего товара',
            details: error.message
        });
    }
});

app.post('/api/favorites/remove', async (req, res) => {
    try {
        const { user_id, product_link } = req.body;
        
        if (!user_id || !product_link) {
            return res.status(400).json({ 
                status: 'error',
                error: 'Не указаны user_id или product_link' 
            });
        }

        const [product] = await pool.execute(
            'SELECT id FROM Products WHERE link_url = ?',
            [product_link]
        );

        if (product.length === 0) {
            return res.status(404).json({ 
                status: 'error',
                error: 'Товар не найден' 
            });
        }

        const productId = product[0].id;

        const [deleteRelation] = await pool.execute(
            'DELETE FROM Users_Products WHERE user_id = ? AND product_id = ?',
            [user_id, productId]
        );

        const [otherRelations] = await pool.execute(
            'SELECT id FROM Users_Products WHERE product_id = ?',
            [productId]
        );

        if (otherRelations.length === 0) {
            await pool.execute(
                'DELETE FROM Product_Photos WHERE product_id = ?',
                [productId]
            );
            
            await pool.execute(
                'DELETE FROM Products WHERE id = ?',
                [productId]
            );
        }

        res.json({ 
            status: 'success',
            message: 'Товар успешно удален из избранного'
        });

    } catch (error) {
        console.error('Ошибка при удалении из избранного:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Ошибка при удалении из избранного',
            details: error.message
        });
    }
});

app.post('/api/favorites', async (req, res) => {
    try {
        const { user_id, product } = req.body;
        const { marketplace, title, price, rating, reviews, link, article, images } = product;
        
        if (!user_id || !marketplace || !title || !price) {
            return res.status(400).json({ 
                status: 'error',
                error: 'Недостаточно данных' 
            });
        }

        const [user] = await pool.execute('SELECT id FROM Users WHERE id = ?', [user_id]);
        if (user.length === 0) {
            return res.status(404).json({ 
                status: 'error',
                error: 'Пользователь не найден' 
            });
        }

        const priceValue = parseInt(price.toString().replace(/\D/g, '')) || 0;
        const ratingValue = parseFloat(rating) || 0;
        const reviewsValue = parseInt(reviews) || 0;

        const [existingProduct] = await pool.execute(
            'SELECT id FROM Products WHERE link_url = ?',
            [link]
        );

        let productId;
        let message = 'Товар успешно добавлен в избранное';
        
        if (existingProduct.length > 0) {
            productId = existingProduct[0].id;
            
            const [existingRelation] = await pool.execute(
                'SELECT id FROM Users_Products WHERE user_id = ? AND product_id = ?',
                [user_id, productId]
            );

            if (existingRelation.length > 0) {
                return res.status(200).json({ 
                    status: 'success',
                    message: 'Товар уже добавлен в избранное',
                    productId: productId
                });
            }
            
            await pool.execute(
                'UPDATE Products SET product_name = ?, price = ?, rating = ?, reviews_count = ? WHERE id = ?',
                [title, priceValue, ratingValue, reviewsValue, productId]
            );
        } else {
            const [productResult] = await pool.execute(
                'INSERT INTO Products (product_name, link_url, price, rating, reviews_count) VALUES (?, ?, ?, ?, ?)',
                [title, link, priceValue, ratingValue, reviewsValue]
            );
            productId = productResult.insertId;

            if (images && images.length > 0) {
                for (const image of images) {
                    await pool.execute(
                        'INSERT INTO Product_Photos (product_id, photo_url) VALUES (?, ?)',
                        [productId, `http://192.168.1.4:3000/images/not%20in%20the%20database/${image}`]
                    );
                }
            }
        }

        await pool.execute(
            'INSERT INTO Users_Products (user_id, product_id) VALUES (?, ?)',
            [user_id, productId]
        );

        res.status(201).json({ 
            status: 'success',
            message: message,
            productId: productId
        });

    } catch (error) {
        console.error('Ошибка при добавлении в избранное:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Ошибка при добавлении в избранное',
            details: error.message
        });
    }
});

app.post('/api/users/delete', async (req, res) => {
    try {
        const { user_id } = req.body;
        
        if (!user_id) {
            return res.status(400).json({ 
                status: 'error',
                error: 'Не указан ID пользователя' 
            });
        }

        const [userProducts] = await pool.execute(
            'SELECT product_id FROM Users_Products WHERE user_id = ?',
            [user_id]
        );

        await pool.execute(
            'DELETE FROM Users_Products WHERE user_id = ?',
            [user_id]
        );

        for (const up of userProducts) {
            const [relations] = await pool.execute(
                'SELECT id FROM Users_Products WHERE product_id = ?',
                [up.product_id]
            );
            
            if (relations.length === 0) {
                await pool.execute(
                    'DELETE FROM Product_Photos WHERE product_id = ?',
                    [up.product_id]
                );
                await pool.execute(
                    'DELETE FROM Products WHERE id = ?',
                    [up.product_id]
                );
            }
        }

        await pool.execute(
            'DELETE FROM Users WHERE id = ?',
            [user_id]
        );

        res.json({ 
            status: 'success',
            message: 'Аккаунт и все связанные данные удалены'
        });

    } catch (error) {
        console.error('Ошибка при удалении аккаунта:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Ошибка при удалении аккаунта',
            details: error.message
        });
    }
});


app.post('/api/products', async (req, res) => {
    try {
        const { marketplace, title, price, rating, reviews, link, article, images } = req.body;
        
        if (!marketplace || !title || !price) {
            return res.status(400).json({ 
                status: 'error',
                error: 'Недостаточно данных о товаре' 
            });
        }

        const priceValue = parseInt(price.toString().replace(/\D/g, '')) || 0;
        const ratingValue = parseFloat(rating) || 0;
        const reviewsValue = parseInt(reviews) || 0;

        const [productResult] = await pool.execute(
            'INSERT INTO Products (product_name, link_url, price, rating, reviews_count) VALUES (?, ?, ?, ?, ?)',
            [title, link, priceValue, ratingValue, reviewsValue]
        );

        const productId = productResult.insertId;

        if (images && images.length > 0) {
            for (const image of images) {
                await pool.execute(
                    'INSERT INTO Product_Photos (product_id, photo_url) VALUES (?, ?)',
                    [productId, `http://192.168.1.4:3000/images/not%20in%20the%20database/${image}`]
                );
            }
        }

        res.status(201).json({ 
            status: 'success',
            message: 'Product saved successfully',
            productId: productId
        });

    } catch (error) {
        console.error('Ошибка при сохранении товара:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Ошибка при сохранении товара',
            details: error.message
        });
    }
});

app.use('/images', express.static(path.join(__dirname, 'images')));

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Что-то пошло не так!' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту: ${PORT}`);
});