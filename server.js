const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const axios = require('axios');
require('dotenv').config();

const app = express();

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
    console.log(`New WebSocket connection from ${ip}`);
    
    // Сохраняем соединение
    clients.set(ip, ws);
    
    // Обработчик закрытия соединения
    ws.on('close', () => {
        clients.delete(ip);
        console.log(`WebSocket connection closed for ${ip}`);
    });
});

const marketplaceQueue = [];
let isPythonServerBusy = false;

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
    
    // Добавляем в очередь
    marketplaces.forEach(mp => {
        marketplaceQueue.push({
            ip,
            query,
            marketplace: mp
        });
    });
    
    // Запускаем обработку очереди
    processQueue();
    
    res.json({ status: 'Search started' });
});

// Функция для проверки статуса Python сервера
async function checkPythonServerStatus() {
    try {
        const response = await axios.get('http://localhost:5000/status');
        return response.data.status === 'ready';
    } catch (error) {
        console.error('Error checking Python server status:', error);
        return false;
    }
}

// Функция обработки очереди
async function processQueue() {
    if (isPythonServerBusy || marketplaceQueue.length === 0) return;
    
    const isServerReady = await checkPythonServerStatus();
    if (!isServerReady) {
        setTimeout(processQueue, 5000); // Повторная проверка через 5 секунд
        return;
    }
    
    isPythonServerBusy = true;
    const task = marketplaceQueue.shift();
    
    try {
        // Отправляем запрос на Python-сервер
        const response = await axios.post('http://localhost:5000/parse', {
            query: task.query,
            marketplace: task.marketplace,
            ip: task.ip
        });
        
        // Обработка успешного ответа
        sendToClient(task.ip, {
            type: 'data',
            marketplace: task.marketplace,
            data: response.data
        });
        
    } catch (error) {
        console.error(`Error processing ${task.marketplace}:`, error);
        // Можно добавить логику повторной попытки или пропуска
    } finally {
        isPythonServerBusy = false;
        processQueue(); // Обрабатываем следующий элемент очереди
    }
}

// Добавляем обработчик для эндпоинта данных
app.post('/api/data', (req, res) => {
    const { ip, marketplace, data } = req.body;
    
    // Отправляем данные клиенту через WebSocket
    sendToClient(ip, {
        type: 'data',
        marketplace: marketplace,
        data: data
    });
    
    res.json({ status: 'Data received' });
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

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Что-то пошло не так!' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту: ${PORT}`);
});