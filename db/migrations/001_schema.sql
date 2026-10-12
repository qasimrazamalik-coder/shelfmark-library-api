-- Shelfmark library schema
-- Money is stored as integer cents. All timestamps are timestamptz.

CREATE TYPE user_role   AS ENUM ('member', 'librarian', 'admin');
CREATE TYPE copy_status AS ENUM ('available', 'on_loan', 'on_hold_shelf', 'lost', 'withdrawn');
CREATE TYPE hold_status AS ENUM ('waiting', 'ready', 'fulfilled', 'cancelled', 'expired');

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  role          user_role   NOT NULL DEFAULT 'member',
  card_number   TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness without the citext extension
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE books (
  id                BIGSERIAL PRIMARY KEY,
  isbn              TEXT UNIQUE,
  title             TEXT        NOT NULL,
  author            TEXT        NOT NULL,
  published_year    INT CHECK (published_year BETWEEN 1400 AND 2100),
  subjects          TEXT[]      NOT NULL DEFAULT '{}',
  replacement_cents INT         NOT NULL DEFAULT 2500 CHECK (replacement_cents >= 0),
  search            TSVECTOR,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX books_search_idx   ON books USING GIN (search);
CREATE INDEX books_subjects_idx ON books USING GIN (subjects);

-- Weighted full-text vector: title > author > subjects.
-- A trigger is used because array_to_string() is not IMMUTABLE,
-- so it cannot live in a generated column.
CREATE FUNCTION books_search_refresh() RETURNS trigger AS $$
BEGIN
  NEW.search :=
      setweight(to_tsvector('simple', coalesce(NEW.title, '')),  'A')
   || setweight(to_tsvector('simple', coalesce(NEW.author, '')), 'B')
   || setweight(to_tsvector('simple', array_to_string(NEW.subjects, ' ')), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER books_search_trg
  BEFORE INSERT OR UPDATE OF title, author, subjects ON books
  FOR EACH ROW EXECUTE FUNCTION books_search_refresh();

CREATE TABLE copies (
  id             BIGSERIAL PRIMARY KEY,
  book_id        BIGINT      NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  barcode        TEXT        NOT NULL UNIQUE,
  shelf_location TEXT,
  status         copy_status NOT NULL DEFAULT 'available',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX copies_book_status_idx ON copies (book_id, status);

CREATE TABLE loans (
  id          BIGSERIAL PRIMARY KEY,
  copy_id     BIGINT      NOT NULL REFERENCES copies(id),
  member_id   BIGINT      NOT NULL REFERENCES users(id),
  loaned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at      TIMESTAMPTZ NOT NULL,
  returned_at TIMESTAMPTZ,
  renewals    INT         NOT NULL DEFAULT 0 CHECK (renewals >= 0),
  CHECK (due_at > loaned_at),
  CHECK (returned_at IS NULL OR returned_at >= loaned_at)
);
-- The database itself guarantees a copy can never be on two open loans.
CREATE UNIQUE INDEX loans_one_open_per_copy ON loans (copy_id) WHERE returned_at IS NULL;
CREATE INDEX loans_open_by_member ON loans (member_id) WHERE returned_at IS NULL;
CREATE INDEX loans_open_due       ON loans (due_at)    WHERE returned_at IS NULL;

CREATE TABLE holds (
  id         BIGSERIAL PRIMARY KEY,
  book_id    BIGINT      NOT NULL REFERENCES books(id),
  member_id  BIGINT      NOT NULL REFERENCES users(id),
  copy_id    BIGINT      REFERENCES copies(id),
  status     hold_status NOT NULL DEFAULT 'waiting',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at   TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  closed_at  TIMESTAMPTZ,
  CHECK (status <> 'ready' OR (copy_id IS NOT NULL AND expires_at IS NOT NULL))
);
-- One live hold per member per title, and one ready hold per physical copy.
CREATE UNIQUE INDEX holds_one_active_per_member ON holds (book_id, member_id) WHERE status IN ('waiting', 'ready');
CREATE UNIQUE INDEX holds_one_ready_per_copy    ON holds (copy_id) WHERE status = 'ready';
CREATE INDEX holds_queue_idx ON holds (book_id, created_at) WHERE status = 'waiting';

CREATE TABLE fines (
  id           BIGSERIAL PRIMARY KEY,
  loan_id      BIGINT      NOT NULL UNIQUE REFERENCES loans(id),
  member_id    BIGINT      NOT NULL REFERENCES users(id),
  amount_cents INT         NOT NULL CHECK (amount_cents > 0),
  reason       TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at      TIMESTAMPTZ,
  waived_at    TIMESTAMPTZ,
  waived_by    BIGINT REFERENCES users(id),
  waive_note   TEXT,
  CHECK (NOT (paid_at IS NOT NULL AND waived_at IS NOT NULL))
);
CREATE INDEX fines_unsettled_by_member ON fines (member_id) WHERE paid_at IS NULL AND waived_at IS NULL;

CREATE TABLE audit_log (
  id        BIGSERIAL PRIMARY KEY,
  actor_id  BIGINT REFERENCES users(id),
  action    TEXT        NOT NULL,
  entity    TEXT        NOT NULL,
  entity_id BIGINT,
  details   JSONB       NOT NULL DEFAULT '{}',
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

-- Read model used by the catalogue: availability per title in one place.
CREATE VIEW book_availability AS
SELECT b.id AS book_id,
       count(c.id) FILTER (WHERE c.status NOT IN ('withdrawn', 'lost')) AS total_copies,
       count(c.id) FILTER (WHERE c.status = 'available')                AS available_copies,
       (SELECT count(*) FROM holds h WHERE h.book_id = b.id AND h.status = 'waiting') AS queue_length
FROM books b
LEFT JOIN copies c ON c.book_id = b.id
GROUP BY b.id;
