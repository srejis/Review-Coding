from normalize import normalize


def append_scores(values, report, formatter=None):
    for score in normalize(values):
        if score >= 0.5:
            report.append(formatter(score) if formatter else score)
    return len(report)
