#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export SUPASCHEMA_COMPARE_DATABASE_URL=${SUPASCHEMA_COMPARE_DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
export SUPASCHEMA_COMPARE_WARMUPS=1
export SUPASCHEMA_COMPARE_TIMEOUT_MS=480000

run_small() {
  SUPASCHEMA_COMPARE_FIXTURES=additive,functions-policies SUPASCHEMA_COMPARE_ITERATIONS=3 \
    SUPASCHEMA_COMPARE_PORT_BASE=55400 \
    SUPASCHEMA_COMPARE_OUT=benchmarks/results/comparison.json node benchmarks/compare.js > /dev/null
  echo "DONE small-fixtures"
}
run_realistic() {
  SUPASCHEMA_COMPARE_FIXTURES=realistic SUPASCHEMA_COMPARE_ITERATIONS=3 \
    SUPASCHEMA_COMPARE_PORT_BASE=56400 \
    SUPASCHEMA_COMPARE_OUT=benchmarks/results/comparison-realistic.json node benchmarks/compare.js > /dev/null
  echo "DONE realistic"
}
run_xl() {
  SUPASCHEMA_COMPARE_XL_TABLES=1000 SUPASCHEMA_COMPARE_FIXTURES=xl SUPASCHEMA_COMPARE_ITERATIONS=3 \
    SUPASCHEMA_COMPARE_PORT_BASE=57400 \
    SUPASCHEMA_COMPARE_OUT=benchmarks/results/comparison-xl.json node benchmarks/compare.js > /dev/null
  echo "DONE xl"
}
run_xxl() {
  SUPASCHEMA_COMPARE_XXL_TABLES=2500 SUPASCHEMA_COMPARE_FIXTURES=xxl SUPASCHEMA_COMPARE_ITERATIONS=1 \
    SUPASCHEMA_COMPARE_PORT_BASE=58400 \
    SUPASCHEMA_COMPARE_OUT=benchmarks/results/comparison-xxl.json node benchmarks/compare.js > /dev/null
  echo "DONE xxl"
}

if [ "${BENCH_ALL_SEQUENTIAL:-0}" = "1" ]; then
  run_small
  run_realistic
  run_xl
  run_xxl
else
  run_small &
  run_realistic &
  run_xl &
  run_xxl &
  wait
fi

node benchmarks/plot.js benchmarks/results/comparison.json benchmarks/results/comparison-realistic.json \
  benchmarks/results/comparison-xl.json benchmarks/results/comparison-xxl.json > /dev/null
cp benchmarks/results/*-latency.svg benchmarks/results/*-correctness.svg docs/public/images/benchmarks/
echo "DONE plot-and-charts"
