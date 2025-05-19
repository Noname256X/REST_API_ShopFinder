const fs = require('fs').promises;
const path = require('path');
const pool = require('./config/db');
const schedule = require('node-schedule');

async function cleanupImages() {
    try {
        const folderPath = path.join(__dirname, 'images', 'not in the database');
        const files = await fs.readdir(folderPath);
        
        const [dbPhotos] = await pool.execute('SELECT photo_url FROM Product_Photos');
        const usedFiles = new Set(dbPhotos.map(photo => {
            const urlParts = photo.photo_url.split('/');
            return decodeURIComponent(urlParts[urlParts.length - 1]);
        }));

        let deletedCount = 0;
        for (const file of files) {
            if (!usedFiles.has(file)) {
                try {
                    await fs.unlink(path.join(folderPath, file));
                    console.log(`Удален файл: ${file}`);
                    deletedCount++;
                } catch (err) {
                    console.error(`Ошибка при удалении ${file}:`, err);
                }
            }
        }
        
        return { 
            status: 'success', 
            message: `Удалено ${deletedCount} файлов`,
            deletedCount
        };
    } catch (error) {
        console.error('Ошибка в cleanupImages:', error);
        throw error;
    }
}

schedule.scheduleJob('0 3 * * *', () => {
    console.log('Запуск автоматической очистки изображений...');
    cleanupImages();
});

module.exports = { cleanupImages };
