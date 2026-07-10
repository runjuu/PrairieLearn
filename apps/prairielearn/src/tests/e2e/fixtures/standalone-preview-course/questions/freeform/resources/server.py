def file(data):
    if data["filename"] == "generated.txt":
        return "generated resource for seed " + str(data["variant_seed"])
    return "unknown generated resource"
