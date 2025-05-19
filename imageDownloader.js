const fs = require('fs');
const path = require('path');
const axios = require('axios');

async function downloadImages(ip, marketplace, productData) {
    try {
        const baseDir = path.join(__dirname, 'images', 'not in the database');
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        const downloadedImages = [];
        
        for (let i = 0; i < productData.image_urls.length; i++) {
            const imageUrl = productData.image_urls[i];
            try {
                const urlParts = imageUrl.split('/');
                let imageName = urlParts[urlParts.length - 1].split('?')[0];
                
                if (!imageName.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                    imageName += '.webp';
                }

                const fileName = `${ip}-${productData.article}-${marketplace}-${i}.webp`;
                const filePath = path.join(baseDir, fileName);

                const response = await axios({
                    method: 'get',
                    url: imageUrl,
                    responseType: 'stream',
                    timeout: 10000
                });

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                downloadedImages.push(fileName);
                console.log(`Изображение сохранено: ${filePath}`);

            } catch (error) {
                console.error(`Ошибка при скачивании изображения ${imageUrl}:`, error.message);
            }
        }

        productData.images = downloadedImages;
        delete productData.image_urls;

        return productData;

    } catch (error) {
        console.error('Ошибка в downloadImages:', error);
        throw error;
    }
}

module.exports = { downloadImages };