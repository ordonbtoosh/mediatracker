const fs = require('fs');

// Read the file
let content = fs.readFileSync('server/server.cjs', 'utf8');

let count = 0;

// Pattern: db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => { if (err) return res.status(500).send(err.message); const settings = rows?.[0] || {};
const pattern1 = /db\.all\("SELECT \* FROM settings WHERE id=1", async \(err, rows\) => \{\s*if \(err\) return res\.status\(500\)\.send\(err\.message\);\s*const settings = rows\?\.\[0\] \|\| \{\};/g;

content = content.replace(pattern1, (match) => {
    count++;
    return 'const settings = await getSettingsRow();';
});

// Pattern: db.all("SELECT * FROM settings WHERE id=1", (err, rows) => { if (err) return res.status(500).send(err.message); const settings = rows?.[0] || {};
const pattern2 = /db\.all\("SELECT \* FROM settings WHERE id=1", \(err, rows\) => \{\s*if \(err\) return res\.status\(500\)\.send\(err\.message\);\s*const settings = rows\?\.\[0\] \|\| \{\};/g;

content = content.replace(pattern2, (match) => {
    count++;
    return 'const settings = await getSettingsRow();';
});

console.log(`Replaced ${count} occurrences`);

// Write back
fs.writeFileSync('server/server.cjs', content, 'utf8');
console.log('Done!');
