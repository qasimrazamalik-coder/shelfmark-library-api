// Demo data: staff and member accounts, a small real catalogue, and some
// circulation history (an overdue loan, a waiting hold, a paid fine) so every
// screen has something to show. Safe to re-run: it wipes and reloads.
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const config = require('../src/config');

const books = [
  ['9780441172719', 'Dune', 'Frank Herbert', 1965, ['science fiction', 'classics'], 2, 'SF HER'],
  ['9780060935467', 'To Kill a Mockingbird', 'Harper Lee', 1960, ['classics', 'law'], 2, 'F LEE'],
  ['9780451524935', 'Nineteen Eighty-Four', 'George Orwell', 1949, ['classics', 'politics'], 3, 'F ORW'],
  ['9780141439518', 'Pride and Prejudice', 'Jane Austen', 1813, ['classics', 'romance'], 2, 'F AUS'],
  ['9780385504201', 'The Da Vinci Code', 'Dan Brown', 2003, ['thriller'], 1, 'F BRO'],
  ['9780062316097', 'Sapiens', 'Yuval Noah Harari', 2011, ['history', 'nonfiction'], 2, '909 HAR'],
  ['9780374533557', 'Thinking, Fast and Slow', 'Daniel Kahneman', 2011, ['psychology', 'nonfiction'], 1, '153.4 KAH'],
  ['9780132350884', 'Clean Code', 'Robert C. Martin', 2008, ['computing', 'software engineering'], 2, '005.1 MAR'],
  ['9780201633610', 'Design Patterns', 'Gamma, Helm, Johnson, Vlissides', 1994, ['computing', 'software engineering'], 1, '005.1 GAM'],
  ['9781449373320', 'Designing Data-Intensive Applications', 'Martin Kleppmann', 2017, ['computing', 'databases'], 1, '005.74 KLE'],
  ['9780262033848', 'Introduction to Algorithms', 'Cormen, Leiserson, Rivest, Stein', 2009, ['computing', 'algorithms'], 2, '005.1 COR'],
  ['9780307474278', 'The Road', 'Cormac McCarthy', 2006, ['fiction'], 1, 'F MCC'],
  ['9780143039433', 'The Grapes of Wrath', 'John Steinbeck', 1939, ['classics'], 1, 'F STE'],
  ['9780060850524', 'Brave New World', 'Aldous Huxley', 1932, ['classics', 'science fiction'], 2, 'F HUX'],
  ['9780316769488', 'The Catcher in the Rye', 'J. D. Salinger', 1951, ['classics'], 1, 'F SAL'],
  ['9780743273565', 'The Great Gatsby', 'F. Scott Fitzgerald', 1925, ['classics'], 2, 'F FIT'],
  ['9780385490818', "The Handmaid's Tale", 'Margaret Atwood', 1985, ['fiction', 'politics'], 1, 'F ATW'],
  ['9780553380163', 'A Brief History of Time', 'Stephen Hawking', 1988, ['science', 'nonfiction'], 1, '523.1 HAW'],
  ['9780679720201', 'The Stranger', 'Albert Camus', 1942, ['classics', 'philosophy'], 1, 'F CAM'],
  ['9780140449136', 'Crime and Punishment', 'Fyodor Dostoevsky', 1866, ['classics', 'philosophy'], 1, 'F DOS'],
  ['9780307387899', 'The Kite Runner', 'Khaled Hosseini', 2003, ['fiction'], 2, 'F HOS'],
  ['9780593135204', 'Project Hail Mary', 'Andy Weir', 2021, ['science fiction'], 1, 'SF WEI'],
];

(async () => {
  const db = new Client({ connectionString: config.databaseUrl });
  await db.connect();
  await db.query('BEGIN');
  await db.query('TRUNCATE audit_log, fines, holds, loans, copies, books, users RESTART IDENTITY CASCADE');

  const hash = await bcrypt.hash('password123', 10);
  const users = [
    ['Nadia Qureshi', 'admin@shelfmark.test', 'admin', 'SM-1000-0001'],
    ['Imran Siddiqui', 'librarian@shelfmark.test', 'librarian', 'SM-1000-0002'],
    ['Amina Khan', 'amina@shelfmark.test', 'member', 'SM-2041-7730'],
    ['Bilal Ahmed', 'bilal@shelfmark.test', 'member', 'SM-2093-1184'],
    ['Sara Malik', 'sara@shelfmark.test', 'member', 'SM-2117-5520'],
  ];
  const ids = {};
  for (const [name, email, role, card] of users) {
    const { rows } = await db.query(
      'INSERT INTO users (name, email, password_hash, role, card_number) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, email, hash, role, card]);
    ids[email.split('@')[0]] = rows[0].id;
  }

  const copyIds = {};
  for (const [isbn, title, author, year, subjects, n, shelf] of books) {
    const { rows: [b] } = await db.query(
      `INSERT INTO books (isbn, title, author, published_year, subjects, replacement_cents)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [isbn, title, author, year, subjects, subjects.includes('computing') ? 6000 : 2000]);
    for (let i = 1; i <= n; i++) {
      const barcode = `B${String(b.id).padStart(4, '0')}-${i}`;
      const { rows: [c] } = await db.query(
        'INSERT INTO copies (book_id, barcode, shelf_location) VALUES ($1,$2,$3) RETURNING id', [b.id, barcode, shelf]);
      copyIds[barcode] = c.id;
    }
  }

  // History, written directly with backdated timestamps.
  const loan = async (barcode, member, loanedDaysAgo, dueInDays, returnedDaysAgo = null) => {
    const { rows: [l] } = await db.query(
      `INSERT INTO loans (copy_id, member_id, loaned_at, due_at, returned_at)
       VALUES ($1, $2, now() - make_interval(days => $3), now() + make_interval(days => $4),
               CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END)
       RETURNING id`,
      [copyIds[barcode], member, loanedDaysAgo, dueInDays, returnedDaysAgo]);
    if (returnedDaysAgo === null) await db.query(`UPDATE copies SET status = 'on_loan' WHERE id = $1`, [copyIds[barcode]]);
    return l.id;
  };

  await loan('B0001-1', ids.amina, 10, 4);          // Dune, due in 4 days
  await loan('B0010-1', ids.amina, 3, 11);          // DDIA, the only copy
  await loan('B0008-1', ids.bilal, 20, -6);         // Clean Code, 6 days overdue
  await loan('B0022-1', ids.sara, 5, 9);            // Project Hail Mary, only copy
  const late = await loan('B0003-1', ids.bilal, 40, -26, 22); // returned 4 days late
  await db.query(`INSERT INTO fines (loan_id, member_id, amount_cents, reason, paid_at)
                  VALUES ($1, $2, 100, 'Returned 4 days late', now() - interval '20 days')`, [late, ids.bilal]);
  for (const [bc, who, ago] of [['B0006-1', 'sara', 30], ['B0003-2', 'amina', 25], ['B0001-2', 'sara', 18], ['B0011-1', 'bilal', 12]]) {
    await loan(bc, ids[who], ago, 14 - ago, ago - 12);
  }

  // Sara is waiting for Designing Data-Intensive Applications.
  await db.query('INSERT INTO holds (book_id, member_id) VALUES (10, $1)', [ids.sara]);

  await db.query('COMMIT');
  await db.end();
  console.log('Seeded. Sign in with any of these (password: password123):');
  for (const [name, email, role] of users) console.log(`  ${role.padEnd(9)} ${email}  (${name})`);
})().catch((err) => { console.error(err); process.exit(1); });
