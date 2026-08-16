package com.recallix.export;

import com.recallix.domain.Language;

/**
 * The headings the export writes itself.
 *
 * <p>A summary written to a template arrives with its own section titles, and
 * those are translated along with the rest of the brief. These five are the ones
 * Recallix adds — the heading over the action items, the heading over the
 * transcript, the note under a section the meeting never reached — and an
 * otherwise Spanish document with "Action items" in the middle of it reads as a
 * translation that gave up half way.
 *
 * <p>Small enough to be a table rather than a resource bundle and a build step,
 * and deliberately short of a sentence: these are labels, and a label is the one
 * thing that can be translated once and be right thereafter. They are worth a
 * native speaker's eye before this ships to paying customers in all eighteen.
 */
public record ExportLabels(
        String summary,
        String keyPoints,
        String actionItems,
        String transcript,
        String notDiscussed
) {

    private static final ExportLabels ENGLISH =
            new ExportLabels("Summary", "Key points", "Action items", "Transcript", "Not discussed.");

    public static ExportLabels of(Language language) {
        if (language == null) {
            return ENGLISH;
        }
        return switch (language) {
            case ENGLISH -> ENGLISH;
            case SPANISH -> new ExportLabels(
                    "Resumen", "Puntos clave", "Tareas", "Transcripción", "No se trató.");
            case GERMAN -> new ExportLabels(
                    "Zusammenfassung", "Kernpunkte", "Aufgaben", "Transkript", "Nicht besprochen.");
            case FRENCH -> new ExportLabels(
                    "Résumé", "Points clés", "Actions à mener", "Transcription", "Non abordé.");
            case PORTUGUESE -> new ExportLabels(
                    "Resumo", "Pontos principais", "Tarefas", "Transcrição", "Não foi discutido.");
            case ITALIAN -> new ExportLabels(
                    "Riepilogo", "Punti chiave", "Attività", "Trascrizione", "Non discusso.");
            case TURKISH -> new ExportLabels(
                    "Özet", "Önemli noktalar", "Görevler", "Deşifre metni", "Görüşülmedi.");
            case DUTCH -> new ExportLabels(
                    "Samenvatting", "Kernpunten", "Actiepunten", "Transcriptie", "Niet besproken.");
            case SWEDISH -> new ExportLabels(
                    "Sammanfattning", "Viktiga punkter", "Åtgärder", "Transkription", "Diskuterades inte.");
            case NORWEGIAN -> new ExportLabels(
                    "Sammendrag", "Hovedpunkter", "Oppgaver", "Transkripsjon", "Ikke diskutert.");
            case DANISH -> new ExportLabels(
                    "Resumé", "Hovedpunkter", "Opgaver", "Transskription", "Ikke drøftet.");
            case FINNISH -> new ExportLabels(
                    "Yhteenveto", "Keskeiset kohdat", "Tehtävät", "Litterointi", "Ei käsitelty.");
            case HINDI -> new ExportLabels(
                    "सारांश", "मुख्य बिंदु", "कार्य बिंदु", "प्रतिलेख", "इस पर चर्चा नहीं हुई।");
            case VIETNAMESE -> new ExportLabels(
                    "Tóm tắt", "Điểm chính", "Việc cần làm", "Bản ghi", "Không được thảo luận.");
            case ARABIC -> new ExportLabels(
                    "الملخص", "النقاط الرئيسية", "المهام", "النص المكتوب", "لم تتم مناقشته.");
            case HEBREW -> new ExportLabels(
                    "תקציר", "נקודות עיקריות", "משימות", "תמליל", "לא נדון.");
            case JAPANESE -> new ExportLabels(
                    "要約", "要点", "アクション項目", "文字起こし", "議論されませんでした。");
            case CHINESE -> new ExportLabels(
                    "摘要", "要点", "待办事项", "转录文本", "未讨论。");
        };
    }
}
