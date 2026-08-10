"""Broker auth wiring.

The failure this guards against is quiet: hand aiokafka the wrong shape and the
worker does not raise, it just retries the connection forever behind the
existing backoff, so the service looks healthy while consuming nothing.
"""

from __future__ import annotations

import ssl

from app.config import Settings
from app.kafka_worker import KafkaWorker


def _worker(**overrides) -> KafkaWorker:
    return KafkaWorker(Settings(**overrides), callback=None, pipeline=None)


def test_plaintext_adds_nothing():
    """The local path must build exactly the client it built before."""
    assert _worker()._security_kwargs() == {}


def test_plaintext_is_the_default():
    assert Settings().kafka_security_protocol == "PLAINTEXT"


def test_sasl_ssl_carries_credentials_and_a_verifying_context():
    kwargs = _worker(
        kafka_security_protocol="SASL_SSL",
        kafka_sasl_username="API_KEY",
        kafka_sasl_password="API_SECRET",
    )._security_kwargs()

    assert kwargs["security_protocol"] == "SASL_SSL"
    assert kwargs["sasl_mechanism"] == "PLAIN"
    assert kwargs["sasl_plain_username"] == "API_KEY"
    assert kwargs["sasl_plain_password"] == "API_SECRET"
    # Certificates must actually be checked: the broker is reached over the
    # public internet, not a private network.
    assert isinstance(kwargs["ssl_context"], ssl.SSLContext)
    assert kwargs["ssl_context"].verify_mode == ssl.CERT_REQUIRED
    assert kwargs["ssl_context"].check_hostname is True


def test_protocol_is_case_insensitive():
    assert _worker(kafka_security_protocol="plaintext")._security_kwargs() == {}


def test_ssl_without_sasl_omits_credentials():
    """SSL alone authenticates the broker, not the client."""
    kwargs = _worker(
        kafka_security_protocol="SSL",
        kafka_sasl_username="unused",
    )._security_kwargs()

    assert kwargs["security_protocol"] == "SSL"
    assert "sasl_plain_username" not in kwargs
    assert isinstance(kwargs["ssl_context"], ssl.SSLContext)


def test_sasl_plaintext_omits_the_ssl_context():
    kwargs = _worker(
        kafka_security_protocol="SASL_PLAINTEXT",
        kafka_sasl_username="API_KEY",
        kafka_sasl_password="API_SECRET",
    )._security_kwargs()

    assert kwargs["sasl_plain_username"] == "API_KEY"
    assert "ssl_context" not in kwargs
