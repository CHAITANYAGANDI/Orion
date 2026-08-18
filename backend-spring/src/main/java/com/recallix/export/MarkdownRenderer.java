package com.recallix.export;

import com.recallix.domain.ExportFormat;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Markdown — the format that pastes.
 *
 * <p>Nothing here is styling; every construct is one a plain-text reader can
 * still make sense of if the markdown is never rendered. That is the whole
 * point of the format and the reason it is worth having alongside DOCX and PDF:
 * the file is legible in the state it arrives in.
 */
@Component
public class MarkdownRenderer implements DocumentRenderer {

    @Override
    public ExportFormat format() {
        return ExportFormat.MARKDOWN;
    }

    @Override
    public byte[] render(ExportDocument doc) {
        List<String> out = new ArrayList<>();

        out.add("# " + doc.title());
        out.add("");
        if (!doc.meta().isEmpty()) {
            out.add("*" + String.join(" · ", doc.meta()) + "*");
            out.add("");
        }
        if (doc.notice() != null) {
            // A blockquote rather than italics: this is a caveat about the whole
            // document, and it has to survive being skimmed past.
            out.add("> " + doc.notice());
            out.add("");
        }

        for (ExportDocument.Block block : doc.blocks()) {
            switch (block) {
                case ExportDocument.Block.Heading h -> {
                    out.add("#".repeat(Math.min(h.level() + 1, 6)) + " " + h.text());
                    out.add("");
                }
                case ExportDocument.Block.Prose p -> {
                    out.add(p.text());
                    out.add("");
                }
                case ExportDocument.Block.Aside a -> {
                    out.add("_" + a.text() + "_");
                    out.add("");
                }
                case ExportDocument.Block.Bullets b -> {
                    b.items().forEach(item -> out.add("- " + item));
                    out.add("");
                }
                case ExportDocument.Block.Tasks t -> {
                    // GitHub-flavoured checkboxes, so the export stays a working
                    // list rather than becoming a record of one.
                    for (ExportDocument.Task task : t.items()) {
                        String detail = task.detail().isBlank() ? "" : " — _" + task.detail() + "_";
                        out.add("- [" + (task.done() ? "x" : " ") + "] " + task.title() + detail);
                    }
                    out.add("");
                }
                case ExportDocument.Block.Transcript t -> {
                    for (ExportDocument.Utterance line : t.lines()) {
                        String label = line.label();
                        out.add(label.isEmpty() ? line.text() : "**" + label + ":** " + line.text());
                        out.add("");
                    }
                }
            }
        }

        out.add("---");
        out.add("");
        out.add("_Exported from Recallix AI_");
        out.add("");
        return String.join("\n", out).getBytes(StandardCharsets.UTF_8);
    }
}
