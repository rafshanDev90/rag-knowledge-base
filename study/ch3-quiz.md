<!-- generated 2026-11-17T16:17:08.120Z · ch3.pdf · 2d7a39b5 -->

## Q1. What is the purpose of the 'from' clause in a typical SQL query structure?

The from clause lists the relations involved in the query and corresponds to the Cartesian product operation of the relational algebra. [p. 10]

## Q2. How does declaring a primary key on an attribute automatically affect that attribute?

A primary key declaration on an attribute automatically ensures not null. [p. 7]

## Q3. What is the difference between varchar(n) and int data types?

varchar(n) represents variable length character strings with a user-specified maximum length n, while int represents an integer (a finite subset of the integers that is machine-dependent). [p. 5]

## Q4. Describe how string matching works in SQL using the LIKE operator.

The like operator uses patterns described by two special characters: percent (%) which matches any substring, and underscore (_) which matches any character. [p. 22]

## Q5. What is a scalar subquery?

A scalar subquery is one which is used where a single value is expected. [p. 57]

## Q6. Explain the difference between using 'IN' and 'NOT IN' when finding courses offered in specific semesters, referencing an example from the text.

The text shows examples of finding courses offered in Fall 2009 AND Spring 2010 using 'in', and those offered in Fall 2009 BUT NOT in Spring 2010 using 'not in'. [p. 43]

## Q7. What is the result when a comparison operation is performed with null, according to three-valued logic?

Any comparison with null returns unknown. [p. 32]

## Q8. How can one find all departments whose average salary exceeds a specific threshold using aggregate functions and grouping?

One can use select dept_name, avg(salary) as avg_salary from instructor group by dept_name and then filter this result using the having clause. [p. 37]

## Q9. What is the function of the 'WITH' clause in complex SQL queries?

The WITH clause allows for defining temporary named results, such as dept_total (dept_name, value) as (select dept_name, sum(salary) from instructor group by dept_name). [p. 56]

## Q10. What is the difference between using 'some' and 'all' clauses in SQL comparisons?

The F <comp> some r means there exists a tuple t in r such that (F <comp> t), while finding instructors whose salary is greater than all instructors in Biology uses the 'all' clause. [p. 45]
