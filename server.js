const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();

const { downloadImages } = require('./imageDownloader');

// Middleware
app.use(cors());
app.use(express.json());

// Создаем HTTP сервер
const server = require('http').createServer(app);

// Создаем WebSocket сервер
const wss = new WebSocket.Server({ server });

// Хранилище клиентов по IP
const clients = new Map();

// Функция для отправки сообщения клиенту по IP
function sendToClient(ip, message) {
    const ws = clients.get(ip);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

// Обработчик WebSocket соединений
wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`Новое подключение к WebSocket от ${ip}`);
    clients.set(ip, ws);
    
    ws.on('close', () => {
        clients.delete(ip);
        console.log(`Соединение с WebSocket закрыто для ${ip}`);
    });
});

// Очередь задач для каждого IP
const queues = new Map();

// Функция для получения или создания очереди для IP
function getQueueForIp(ip) {
    if (!queues.has(ip)) {
        queues.set(ip, {
            tasks: [],
            isProcessing: false
        });
    }
    return queues.get(ip);
}

// Routes
const authRoutes = require('./routes/authRoutes');
app.use('/api/auth', authRoutes);

// Добавляем новый маршрут для поиска
app.post('/api/search', (req, res) => {
    const { query, ip } = req.body;
    
    // Формируем очередь маркетплейсов
    const marketplaces = [
        'Ozon', 'Wildberries', 'YandexMarket', 'MagnitMarket', 
        'DNS', 'Citilink', 'M_Video', 'Aliexpress', 
        'Joom', 'Shop_mts', 'Technopark', 'Lamoda'
    ];

    // Получаем очередь для этого IP
    const queue = getQueueForIp(ip);
    
    // Добавляем все маркетплейсы в очередь
    marketplaces.forEach(mp => {
        queue.tasks.push({
            ip,
            query,
            marketplace: mp
        });
    });
    
    // Запускаем обработку очереди, если она еще не обрабатывается
    if (!queue.isProcessing) {
        processQueueForIp(ip);
    }
    
    res.json({ status: 'Search started' });
});

// Функция для обработки очереди конкретного IP
async function processQueueForIp(ip) {
    const queue = getQueueForIp(ip);
    if (queue.isProcessing || queue.tasks.length === 0) return;
    
    queue.isProcessing = true;
    const task = queue.tasks[0]; // Берем первую задачу, но не удаляем ее сразу
    
    console.log(`Обработка: ${task.marketplace} для ${task.ip}`);
    
    try {
        // Отправляем статус начала обработки
        sendToClient(task.ip, {
            type: 'status',
            message: `${task.marketplace}: Начало парсинга`
        });
        
        const response = await axios.post('http://192.168.1.4:5000/parse', {
            query: task.query,
            marketplace: task.marketplace,
            ip: task.ip
        }, { timeout: 500000 }); // Увеличиваем таймаут до 500 секунд
        
        // Ждем подтверждения завершения от Python сервера
        await waitForCompletion(task.ip, task.marketplace);
        
        console.log(`Успешно обработан ${task.marketplace}`);
        
        // Удаляем выполненную задачу из очереди
        queue.tasks.shift();
        
        // Отправляем статус завершения
        sendToClient(task.ip, {
            type: 'status',
            message: `${task.marketplace}: Парсинг завершен`
        });
        
    } catch (error) {
        console.error(`Ошибка обработки ${task.marketplace}:`, error);
        
        // Отправляем статус ошибки
        sendToClient(task.ip, {
            type: 'status',
            message: `${task.marketplace}: Ошибка парсинга - ${error.message}`
        });
        
        // В случае ошибки можно либо оставить задачу в очереди для повторения,
        // либо пропустить ее и перейти к следующей
        queue.tasks.shift(); // Пропускаем текущую задачу
    } finally {
        queue.isProcessing = false;
        
        // Проверяем, есть ли еще задачи в очереди
        if (queue.tasks.length > 0) {
            // Рекурсивно вызываем обработку следующей задачи
            processQueueForIp(ip);
        } else {
            // Очередь пуста, можно удалить ее из хранилища
            queues.delete(ip);
        }
    }
}

// Функция ожидания завершения (может быть улучшена)
function waitForCompletion(ip, marketplace) {
    return new Promise((resolve) => {
        // В реальной реализации здесь можно использовать WebSocket
        // для получения подтверждения от Python сервера
        // Пока просто ждем фиксированное время
        setTimeout(resolve, 30000); // 30 секунд
    });
}

// Модифицируем обработчик /api/data
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
        
        // Отправляем обработанные данные клиенту
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

// Добавляем обработчик для эндпоинта статусов
app.post('/api/status', (req, res) => {
    const { ip, message } = req.body;
    
    // Отправляем статус клиенту через WebSocket
    sendToClient(ip, {
        type: 'status',
        message: message
    });
    
    res.json({ status: 'Status received' });
});

// Добавьте в server.js перед запуском сервера
app.use('/images', express.static(path.join(__dirname, 'images')));

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Что-то пошло не так!' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту: ${PORT}`);
});