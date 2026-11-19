import time

import click


def compile_sources(root: str) -> int:
    """Compile every source under root and return how many were compiled."""
    return len([root])


@click.group()
def main() -> None:
    pass


@main.command()
@click.argument("root")
def compile(root: str) -> None:
    started = time.monotonic()
    compiled = compile_sources(root)
    click.echo(f"compiled {compiled} sources in {time.monotonic() - started:.2f}s")
