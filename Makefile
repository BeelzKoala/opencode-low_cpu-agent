.PHONY: check quick full env corpus

check: full

quick:
	./ci quick

full:
	./ci full

env:
	./ci env

corpus:
	./ci corpus
