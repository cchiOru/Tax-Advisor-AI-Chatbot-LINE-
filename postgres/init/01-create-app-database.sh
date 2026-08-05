#!/bin/bash
# สร้างฐานข้อมูลแยกต่างหากสำหรับข้อมูลแอป (tax_advisor)
# นอกเหนือจากฐานข้อมูลที่ n8n ใช้เก็บข้อมูลภายในของตัวเอง (POSTGRES_DB)
# สคริปต์นี้จะถูกรันอัตโนมัติครั้งแรกที่ container postgres ถูกสร้าง (volume ว่างเปล่า)
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE "${APP_DB_NAME}";
EOSQL

echo "Created database '${APP_DB_NAME}'"
