import os
import time
import uuid
from pathlib import Path

import pytest
import requests


BASE_URL = os.getenv("BASE_URL", "http://localhost:3000").rstrip("/")
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RECEIPT_FILE = REPO_ROOT / "load-tests" / "samples" / "Receipt.png"
RECEIPT_FILE = Path(os.getenv("RECEIPT_FILE", str(DEFAULT_RECEIPT_FILE))).resolve()
USER_ID = f"api-test-{uuid.uuid4()}"


def user_headers():
    return {"X-User-Id": USER_ID}


def assert_json_response(response):
    assert response.headers.get("content-type", "").lower().startswith("application/json")


def test_receipts_history_returns_json():
    response = requests.get(f"{BASE_URL}/receipts", headers=user_headers(), timeout=10)

    assert response.status_code == 200
    assert_json_response(response)
    assert isinstance(response.json(), list)


def test_monthly_analytics_returns_json():
    response = requests.get(f"{BASE_URL}/analytics/monthly", headers=user_headers(), timeout=10)

    assert response.status_code == 200
    assert_json_response(response)
    data = response.json()
    assert "month" in data
    assert "receiptCount" in data
    assert "categories" in data
    assert isinstance(data["categories"], list)


def test_unknown_transaction_output_returns_not_found_status():
    transaction_id = f"TXN-NOT-FOUND-{uuid.uuid4()}"
    response = requests.get(f"{BASE_URL}/receipts/{transaction_id}/output", headers=user_headers(), timeout=10)

    assert response.status_code == 200
    assert_json_response(response)
    data = response.json()
    assert data["transactionId"] == transaction_id
    assert data["status"] == "not_found"
    assert data["data"] == {}


def test_accuracy_metrics_endpoint():
    payload = {
        "expected": {
            "vendor": {"name": "Red Store"},
            "totals": {"total": 320.63},
        },
        "actual": {
            "vendor": {"name": "Red Store"},
            "totals": {"total": 320.63},
        },
    }

    response = requests.post(f"{BASE_URL}/metrics/accuracy", json=payload, headers=user_headers(), timeout=10)

    assert response.status_code in (200, 201)
    assert_json_response(response)
    data = response.json()
    assert data["target_field_accuracy"] == 0.85
    assert data["field_accuracy"] == 1
    assert data["precision"] == 1
    assert data["recall"] == 1


@pytest.mark.skipif(not RECEIPT_FILE.exists(), reason="Receipt sample file not found")
def test_upload_receipt_returns_transaction_id_and_status():
    with RECEIPT_FILE.open("rb") as file:
        response = requests.post(
            f"{BASE_URL}/upload",
            headers=user_headers(),
            files={"receipt": (RECEIPT_FILE.name, file, "image/png")},
            timeout=30,
        )

    assert response.status_code in (200, 201, 202)
    assert_json_response(response)
    data = response.json()
    assert "transactionId" in data
    assert data["status"] in ("queued", "processing", "duplicate_pending")

    transaction_id = data["transactionId"]
    status_response = requests.get(f"{BASE_URL}/receipts/{transaction_id}/output", headers=user_headers(), timeout=10)
    assert status_response.status_code == 200
    status_data = status_response.json()
    assert status_data["transactionId"] == transaction_id
    assert status_data["status"] in ("queued", "processing", "completed", "failed", "duplicate_pending")


@pytest.mark.skipif(not RECEIPT_FILE.exists(), reason="Receipt sample file not found")
def test_uploaded_receipt_reaches_terminal_or_active_status():
    with RECEIPT_FILE.open("rb") as file:
        response = requests.post(
            f"{BASE_URL}/upload",
            headers=user_headers(),
            files={"receipt": (RECEIPT_FILE.name, file, "image/png")},
            timeout=30,
        )

    assert response.status_code in (200, 201, 202)
    transaction_id = response.json()["transactionId"]

    final_status = None
    for _ in range(6):
        status_response = requests.get(f"{BASE_URL}/receipts/{transaction_id}/output", headers=user_headers(), timeout=10)
        assert status_response.status_code == 200
        final_status = status_response.json()["status"]
        if final_status in ("completed", "failed", "duplicate_pending"):
            break
        time.sleep(2)

    assert final_status in ("processing", "completed", "failed", "duplicate_pending")
