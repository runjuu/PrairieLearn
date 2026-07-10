def generate(data):
    data["params"]["seed"] = str(data["variant_seed"])
    data["correct_answers"]["ans"] = 2
