package com.recallix.export;

import com.recallix.domain.ExportFormat;

/**
 * Turns a {@link ExportDocument} into the bytes of one file.
 *
 * <p>Implementations are stateless singletons and hold nothing about the
 * request: everything a format needs to know — including what script it is
 * typesetting and which way it runs — is on the document.
 */
public interface DocumentRenderer {

    ExportFormat format();

    byte[] render(ExportDocument document);
}
