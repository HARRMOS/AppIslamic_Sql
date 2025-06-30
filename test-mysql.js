const mysql = require('mysql2/promise');

async function test() {
  try {
    const connection = await mysql.createConnection({
      host: 'mh285989-001.eu.clouddb.ovh.net',
      port: 35693,
      user: 'bts',
      password: 'Harris91270',
      database: 'islamicApp'
    });
    const [rows] = await connection.query('SELECT 1');
    console.log('Connexion OK !', rows);
    await connection.end();
  } catch (err) {
    console.error('Erreur connexion :', err);
  }
}

test(); 