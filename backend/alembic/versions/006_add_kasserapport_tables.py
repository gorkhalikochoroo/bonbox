"""add kasserapport_extractions + kasserapport_examples tables

Logs every kasserapport OCR attempt + maintains a curated few-shot
example library used to refine extractor prompts over time.

Revision ID: f6g7h8i9j0k1
Revises: e5f6g7h8i9j0
Create Date: 2026-05-06

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision = "f6g7h8i9j0k1"
down_revision = "e5f6g7h8i9j0"
branch_labels = None
depends_on = None


def upgrade():
    # Use JSONB on Postgres, JSON on SQLite (engine inspects via sa.JSON()).
    json_type = sa.JSON().with_variant(JSONB, "postgresql")

    op.create_table(
        "kasserapport_extractions",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"), primary_key=True),
        sa.Column("user_id", sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"), sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("image_url", sa.String(500), nullable=True),
        sa.Column("document_type", sa.String(40), server_default="unknown", nullable=False),
        sa.Column("pos_system", sa.String(40), server_default="unknown", nullable=False),
        sa.Column("classifier_confidence", sa.Numeric(4, 3), nullable=True),
        sa.Column("format_confidence", sa.Numeric(4, 3), nullable=True),
        sa.Column("extraction_confidence", sa.Numeric(4, 3), nullable=True),
        sa.Column("extracted_json", json_type, nullable=True),
        sa.Column("validator_failures", json_type, nullable=True),
        sa.Column("manual_review_needed", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("final_json", json_type, nullable=True),
        sa.Column("user_corrected", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("timing_ms", json_type, nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("image_sha256", sa.String(64), nullable=True),
        sa.Column("prompt_version", sa.String(80), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("committed_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_kasse_extractions_user_created", "kasserapport_extractions", ["user_id", "created_at"])
    op.create_index("ix_kasse_extractions_pos_system", "kasserapport_extractions", ["pos_system"])
    op.create_index("ix_kasse_extractions_image_sha256", "kasserapport_extractions", ["image_sha256"])
    op.create_index("ix_kasserapport_extractions_user_id", "kasserapport_extractions", ["user_id"])
    op.create_index("ix_kasserapport_extractions_created_at", "kasserapport_extractions", ["created_at"])

    op.create_table(
        "kasserapport_examples",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"), primary_key=True),
        sa.Column("user_id", sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"), sa.ForeignKey("users.id"), nullable=True, index=True),
        sa.Column("is_global", sa.Boolean(), server_default=sa.text("false"), nullable=False, index=True),
        sa.Column("pos_system", sa.String(40), server_default="unknown", nullable=False, index=True),
        sa.Column("image_url", sa.String(500), nullable=True),
        sa.Column("truth_json", json_type, nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("promoted_from_extraction_id", sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"), sa.ForeignKey("kasserapport_extractions.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )


def downgrade():
    op.drop_index("ix_kasserapport_extractions_created_at", table_name="kasserapport_extractions")
    op.drop_index("ix_kasserapport_extractions_user_id", table_name="kasserapport_extractions")
    op.drop_index("ix_kasse_extractions_image_sha256", table_name="kasserapport_extractions")
    op.drop_index("ix_kasse_extractions_pos_system", table_name="kasserapport_extractions")
    op.drop_index("ix_kasse_extractions_user_created", table_name="kasserapport_extractions")
    op.drop_table("kasserapport_examples")
    op.drop_table("kasserapport_extractions")
