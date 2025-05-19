const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const register = async (req, res) => {
  try {
    const { nickname, email, password } = req.body;
    
    if (!nickname || !email || !password) {
      return res.status(400).json({ error: 'Все поля обязательны для заполнения' });
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Некорректный формат email' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен содержать минимум 6 символов' });
    }
    
    const [existingEmail] = await pool.execute(
      'SELECT * FROM Users WHERE email = ?',
      [email]
    );
    
    if (existingEmail.length > 0) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }
    
    const [existingNickname] = await pool.execute(
      'SELECT * FROM Users WHERE nickname = ?',
      [nickname]
    );
    
    if (existingNickname.length > 0) {
      return res.status(409).json({ error: 'Пользователь с таким никнеймом уже существует' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
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
    
    if (!nickname || !password) {
      return res.status(400).json({ error: 'Все поля обязательны для заполнения' });
    }
    
    const [users] = await pool.execute(
      'SELECT * FROM Users WHERE nickname = ?',
      [nickname]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }
    
    const user = users[0];
    
    if (user.deleted_at !== null) {
      return res.status(401).json({ 
        error: 'Аккаунт удален',
        is_deleted: true 
      });
    }
    
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }
    
    res.status(200).json({ 
      message: 'Авторизация успешна',
      userId: user.id,
      is_deleted: false
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