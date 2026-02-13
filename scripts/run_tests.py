#!/usr/bin/env python3
"""
Test runner script for TMDB metadata processing tests.

Usage:
    python run_tests.py [options]
    
Examples:
    python run_tests.py                    # Run all tests
    python run_tests.py --unit             # Run only unit tests
    python run_tests.py --performance      # Run performance tests
    python run_tests.py --coverage         # Run with coverage report
"""

import sys
import subprocess
import argparse
from pathlib import Path


def run_command(cmd, description):
    """Run a command and display results."""
    print(f"\n{'='*60}")
    print(f"Running: {description}")
    print(f"{'='*60}\n")
    
    result = subprocess.run(cmd, shell=True)
    
    if result.returncode != 0:
        print(f"\n❌ {description} failed with code {result.returncode}")
        return False
    else:
        print(f"\n✅ {description} completed successfully")
        return True


def main():
    parser = argparse.ArgumentParser(description="Run TMDB metadata processing tests")
    
    # Test selection
    parser.add_argument('--all', action='store_true', help='Run all tests (default)')
    parser.add_argument('--unit', action='store_true', help='Run only unit tests')
    parser.add_argument('--integration', action='store_true', help='Run only integration tests')
    parser.add_argument('--business-rules', action='store_true', help='Run business rules tests')
    parser.add_argument('--file-generation', action='store_true', help='Run file generation tests')
    parser.add_argument('--performance', action='store_true', help='Run performance tests')
    
    # Options
    parser.add_argument('--coverage', action='store_true', help='Generate coverage report')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')
    parser.add_argument('--fast', action='store_true', help='Skip slow tests')
    parser.add_argument('--failfast', '-x', action='store_true', help='Stop on first failure')
    parser.add_argument('--pdb', action='store_true', help='Drop into debugger on failure')
    
    args = parser.parse_args()
    
    # Build pytest command
    cmd_parts = ['pytest']
    
    # Add test markers
    markers = []
    if args.unit:
        markers.append('unit')
    if args.integration:
        markers.append('integration')
    if args.business_rules:
        markers.append('business_rules')
    if args.file_generation:
        markers.append('file_generation')
    if args.performance:
        markers.append('performance')
    
    if markers:
        cmd_parts.append(f'-m "{" or ".join(markers)}"')
    
    # Add options
    if args.verbose:
        cmd_parts.append('-vv')
    else:
        cmd_parts.append('-v')
    
    if args.fast:
        cmd_parts.append('-m "not slow"')
    
    if args.failfast:
        cmd_parts.append('-x')
    
    if args.pdb:
        cmd_parts.append('--pdb')
    
    if args.coverage:
        cmd_parts.extend([
            '--cov=utils',
            '--cov=.',
            '--cov-report=html',
            '--cov-report=term-missing'
        ])
    
    # Add tests directory
    cmd_parts.append('tests/')
    
    # Run tests
    cmd = ' '.join(cmd_parts)
    success = run_command(cmd, "Test Suite")
    
    if args.coverage and success:
        print("\n" + "="*60)
        print("Coverage report generated: htmlcov/index.html")
        print("="*60)
    
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
