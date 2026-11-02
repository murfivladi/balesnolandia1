-- Удаление товара из кассы. Строку не стираем: иначе старые чеки, возвраты,
-- складские движения и отчёты потеряют название, цену и категорию товара.
-- Удалённый товар скрыт из каталога и не продаётся; его можно восстановить тем же id.
ALTER TABLE products
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER active,
  ADD INDEX idx_product_shop_deleted (shop_id, deleted_at);
