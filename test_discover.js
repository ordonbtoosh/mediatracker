const http = require('http');

const url = 'http://localhost:3000/api/discover?type=movies&genre=Drama&sort=popularity.desc';

http.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        try {
            const json = JSON.parse(data);
            if (json.results && json.results.length > 0) {
                console.log('First result genre:', json.results[0].genre);
                console.log('First result title:', json.results[0].title);
            } else {
                console.log('No results or structure mismatch:', json);
            }
        } catch (e) {
            console.log('Error parsing JSON:', data.substring(0, 100));
        }
    });
}).on('error', (err) => {
    console.log('Error:', err.message);
});
