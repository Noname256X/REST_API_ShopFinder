const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const register = async (req, res) => {
  try {
    const { nickname, email, password } = req.body;
    
    // Проверка на пустые поля
    if (!nickname || !email || !password) {
      return res.status(400).json({ error: 'Все поля обязательны для заполнения' });
    }
    
    // Проверка формата email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Некорректный формат email' });
    }
    
    // Проверка длины пароля
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен содержать минимум 6 символов' });
    }
    
    // Хеширование пароля
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Проверка существования пользователя
    const [existingUser] = await pool.execute(
      'SELECT * FROM Users WHERE email = ?',
      [email]
    );
    
    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }
    
    // Создание пользователя
    const [result] = await pool.execute(
      'INSERT INTO Users (nickname, email, password) VALUES (?, ?, ?)',
      [nickname, email, hashedPassword]
    );
    
    res.status(201).json({ 
      message: 'Пользователь успешно зарегистрирован',
      userId: result.insertId 
    });
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Ошибка при регистрации пользователя' });
  }
};

const login = async (req, res) => {
  try {
    const { nickname, password } = req.body;
    
    // Проверка на пустые поля
    if (!nickname || !password) {
      return res.status(400).json({ error: 'Все поля обязательны для заполнения' });
    }
    
    // Поиск пользователя по никнейму
    const [users] = await pool.execute(
      'SELECT * FROM Users WHERE nickname = ?',
      [nickname]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }
    
    const user = users[0];
    
    // Проверка пароля
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }
    
    // Успешная авторизация
    res.status(200).json({ 
      message: 'Авторизация успешна',
      userId: user.id 
    });
  } catch (error) {
    console.error('Ошибка авторизации:', error);
    res.status(500).json({ error: 'Ошибка при авторизации пользователя' });
  }
};

module.exports = { 
  register,
  login
};